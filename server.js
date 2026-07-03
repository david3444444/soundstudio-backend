const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

app.get('/ping', (req, res) => {
  res.json({ status: 'ok', message: 'SoundStudio backend is awake' });
});

const binDir = path.join(__dirname, 'bin');
const ytdlpPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// Ensure bin directory exists
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir);
}

// Function to download yt-dlp if it doesn't exist
function ensureYtdlp() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(ytdlpPath)) {
      return resolve(ytdlpPath);
    }

    console.log('Downloading yt-dlp binary dynamically for platform: ' + process.platform);
    const url = process.platform === 'win32'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

    const file = fs.createWriteStream(ytdlpPath);
    
    function download(downloadUrl) {
      https.get(downloadUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          download(response.headers.location);
        } else if (response.statusCode === 200) {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            if (process.platform !== 'win32') {
              fs.chmodSync(ytdlpPath, '755');
            }
            console.log('yt-dlp binary download completed successfully.');
            resolve(ytdlpPath);
          });
        } else {
          fs.unlink(ytdlpPath, () => {});
          reject(new Error(`Failed to download binary: Status code ${response.statusCode}`));
        }
      }).on('error', (err) => {
        fs.unlink(ytdlpPath, () => {});
        reject(err);
      });
    }

    download(url);
  });
}

async function resolveInvidiousFallback(query) {
  const instances = [
    'https://invidious.projectsegfau.lt',
    'https://yewtu.be',
    'https://inv.tux.im',
  ];
  
  let videoId = '';
  
  for (const instance of instances) {
    try {
      const searchUrl = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
      const response = await new Promise((resolve, reject) => {
        https.get(searchUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        }).on('error', reject);
      });
      
      if (response && response.length > 0) {
        videoId = response[0].videoId;
        if (videoId) break;
      }
    } catch (e) {
      console.log(`Invidious search fallback failed on ${instance}: ${e.message}`);
    }
  }

  if (!videoId) {
    throw new Error('Failed to find video ID via Invidious');
  }

  for (const instance of instances) {
    try {
      const videoUrl = `${instance}/api/v1/videos/${videoId}`;
      const data = await new Promise((resolve, reject) => {
        https.get(videoUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        }).on('error', reject);
      });

      if (data && data.adaptiveFormats) {
        let bestUrl = '';
        let maxBitrate = 0;
        for (const format of data.adaptiveFormats) {
          const type = format.type || '';
          if (type.startsWith('audio/')) {
            const bitrate = parseInt(format.bitrate) || 0;
            if (bitrate > maxBitrate) {
              maxBitrate = bitrate;
              bestUrl = format.url;
            }
          }
        }
        if (bestUrl) {
          return bestUrl;
        }
      }
    } catch (e) {
      console.log(`Invidious stream fetch fallback failed on ${instance}: ${e.message}`);
    }
  }
  
  throw new Error('Failed to resolve stream URL via Invidious');
}

app.get('/resolve', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  try {
    const exePath = await ensureYtdlp();
    console.log(`Resolving stream for query: "${query}"`);

    const cmd = `"${exePath}" "ytsearch1:${query}" -f "ba" -g`;

    exec(cmd, async (error, stdout, stderr) => {
      if (error) {
        console.warn(`yt-dlp failed on server, trying Invidious fallback: ${error.message}`);
        try {
          const streamUrl = await resolveInvidiousFallback(query);
          console.log(`Resolved via Invidious fallback: ${streamUrl.substring(0, 60)}...`);
          return res.json({ streamUrl });
        } catch (fallbackErr) {
          console.error(`Fallback also failed: ${fallbackErr.message}`);
          return res.status(500).json({ error: 'Failed to resolve stream URL', details: error.message });
        }
      }
      const streamUrl = stdout.trim();
      if (!streamUrl) {
        return res.status(404).json({ error: 'No stream URL found' });
      }
      console.log(`Resolved: ${streamUrl.substring(0, 60)}...`);
      res.json({ streamUrl });
    });
  } catch (err) {
    console.error(`Failed to ensure yt-dlp: ${err}`);
    res.status(500).json({ error: 'Failed to initialize yt-dlp binary', details: err.message });
  }
});

app.get('/download', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  try {
    const exePath = await ensureYtdlp();
    console.log(`Downloading audio stream for query: "${query}"`);
    
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }
    
    const outputFilename = `${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const outputPath = path.join(tempDir, outputFilename);
    
    const cmd = `"${exePath}" "ytsearch1:${query}" -f "ba" -o "${outputPath}"`;
    
    console.log(`Executing: ${cmd}`);
    exec(cmd, async (error, stdout, stderr) => {
      if (error) {
        console.warn(`yt-dlp download failed, trying Invidious download fallback: ${error.message}`);
        try {
          const streamUrl = await resolveInvidiousFallback(query);
          console.log(`Downloading stream from fallback URL: ${streamUrl.substring(0, 60)}...`);
          
          const file = fs.createWriteStream(outputPath);
          
          function downloadStream(downloadUrl) {
            const client = downloadUrl.startsWith('https') ? https : require('http');
            client.get(downloadUrl, (response) => {
              if (response.statusCode === 302 || response.statusCode === 301) {
                downloadStream(response.headers.location);
              } else if (response.statusCode === 200) {
                response.pipe(file);
                file.on('finish', () => {
                  file.close();
                  console.log(`Fallback download successful: ${outputPath}`);
                  res.download(outputPath, `${query}.mp3`, (err) => {
                    fs.unlink(outputPath, () => {});
                  });
                });
              } else {
                fs.unlink(outputPath, () => {});
                res.status(500).json({ error: `Fallback download failed: Status code ${response.statusCode}` });
              }
            }).on('error', (err) => {
              fs.unlink(outputPath, () => {});
              res.status(500).json({ error: 'Fallback download failed', details: err.message });
            });
          }

          downloadStream(streamUrl);
          return;
        } catch (fallbackErr) {
          console.error(`Fallback download also failed: ${fallbackErr.message}`);
          return res.status(500).json({ error: 'Failed to download audio stream', details: error.message });
        }
      }
      
      if (!fs.existsSync(outputPath)) {
        return res.status(404).json({ error: 'Output file was not created' });
      }
      
      console.log(`Sending file: ${outputPath}`);
      res.download(outputPath, `${query}.mp3`, (err) => {
        fs.unlink(outputPath, () => {});
      });
    });
  } catch (err) {
    console.error(`Failed during download process: ${err}`);
    res.status(500).json({ error: 'Download initialization failed', details: err.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`SoundStudio backend listening at http://0.0.0.0:${port}`);
});
