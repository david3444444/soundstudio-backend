const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const ytSearch = require('yt-search');

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

function runYtdlp(exePath, videoUrl, formatArgs, extraArgs = '') {
  return new Promise((resolve, reject) => {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
      const cmd = `"${exePath}" "${videoUrl}" ${formatArgs} --cookies "${cookiesPath}" ${extraArgs}`;
      console.log(`Running yt-dlp with cookies.txt: ${cmd}`);
      exec(cmd, (err, stdout, stderr) => {
        if (!err) return resolve(stdout.trim());
        console.warn(`yt-dlp with cookies.txt failed: ${err.message}`);
        tryNext();
      });
      return;
    }
    
    tryNext();

    function tryNext() {
      if (process.platform === 'win32' || process.platform === 'darwin') {
        const browsers = ['chrome', 'edge', 'firefox'];
        let currentBrowserIdx = 0;
        
        function tryBrowser() {
          if (currentBrowserIdx >= browsers.length) {
            tryNoCookies();
            return;
          }
          const browser = browsers[currentBrowserIdx++];
          const cmd = `"${exePath}" "${videoUrl}" ${formatArgs} --cookies-from-browser ${browser} ${extraArgs}`;
          console.log(`Trying local browser cookies (${browser}): ${cmd}`);
          exec(cmd, (err, stdout, stderr) => {
            if (!err) return resolve(stdout.trim());
            console.warn(`yt-dlp with browser ${browser} cookies failed: ${err.message}`);
            tryBrowser();
          });
        }
        
        tryBrowser();
      } else {
        tryNoCookies();
      }
    }

    function tryNoCookies() {
      const cmd = `"${exePath}" "${videoUrl}" ${formatArgs} ${extraArgs}`;
      console.log(`Running yt-dlp without cookies: ${cmd}`);
      exec(cmd, (err, stdout, stderr) => {
        if (!err) return resolve(stdout.trim());
        reject(err);
      });
    }
  });
}

app.get('/resolve', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  try {
    console.log(`Searching YouTube for: "${query}"`);
    const searchResult = await ytSearch(query);
    if (!searchResult || !searchResult.videos || searchResult.videos.length === 0) {
      return res.status(404).json({ error: 'No video results found for the query' });
    }

    const video = searchResult.videos[0];
    const videoId = video.videoId;
    const title = video.title;
    const thumbnail = video.thumbnail || video.image || '';
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const exePath = await ensureYtdlp();
    console.log(`Resolving stream for video ID: ${videoId} (${title})`);

    try {
      const streamUrl = await runYtdlp(exePath, videoUrl, '-f "ba" -g --js-runtimes node --force-ipv4');
      if (!streamUrl) {
        throw new Error('No stream URL resolved by yt-dlp');
      }
      console.log(`Resolved: ${streamUrl.substring(0, 60)}...`);
      return res.json({
        title,
        videoId,
        thumbnail,
        streamUrl
      });
    } catch (error) {
      console.warn(`yt-dlp failed on server, trying Invidious fallback: ${error.message}`);
      try {
        const streamUrl = await resolveInvidiousFallback(query);
        console.log(`Resolved via Invidious fallback: ${streamUrl.substring(0, 60)}...`);
        return res.json({
          title,
          videoId,
          thumbnail,
          streamUrl
        });
      } catch (fallbackErr) {
        console.error(`Fallback also failed: ${fallbackErr.message}`);
        return res.status(500).json({ error: 'Failed to resolve stream URL', details: error.message });
      }
    }
  } catch (err) {
    console.error(`Error in /resolve route: ${err}`);
    res.status(500).json({ error: 'Failed to resolve stream', details: err.message });
  }
});

app.get('/download', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  try {
    console.log(`Searching YouTube for download: "${query}"`);
    const searchResult = await ytSearch(query);
    if (!searchResult || !searchResult.videos || searchResult.videos.length === 0) {
      return res.status(404).json({ error: 'No video results found for the query' });
    }

    const video = searchResult.videos[0];
    const videoId = video.videoId;
    const title = video.title;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const exePath = await ensureYtdlp();
    console.log(`Downloading audio stream for video: ${videoUrl}`);
    
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }
    
    const outputFilename = `${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const outputPath = path.join(tempDir, outputFilename);
    
    try {
      await runYtdlp(exePath, videoUrl, `-f "ba" -o "${outputPath}" --js-runtimes node --force-ipv4`);
      
      if (!fs.existsSync(outputPath)) {
        throw new Error('Output file was not created');
      }
      
      console.log(`Sending file: ${outputPath}`);
      return res.download(outputPath, `${title}.mp3`, (err) => {
        fs.unlink(outputPath, () => {});
      });
    } catch (error) {
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
                res.download(outputPath, `${title}.mp3`, (err) => {
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
      } catch (fallbackErr) {
        console.error(`Fallback download also failed: ${fallbackErr.message}`);
        return res.status(500).json({ error: 'Failed to download audio stream', details: error.message });
      }
    }
  } catch (err) {
    console.error(`Failed during download process: ${err}`);
    res.status(500).json({ error: 'Download initialization failed', details: err.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`SoundStudio backend listening at http://0.0.0.0:${port}`);
});
