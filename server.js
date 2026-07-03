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

app.get('/resolve', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  try {
    const exePath = await ensureYtdlp();
    console.log(`Resolving stream for query: "${query}"`);

    const cmd = `"${exePath}" "ytsearch1:${query}" -f "ba" -g`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing yt-dlp: ${error.message}`);
        return res.status(500).json({ error: 'Failed to resolve stream URL', details: error.message });
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

app.listen(port, '0.0.0.0', () => {
  console.log(`SoundStudio backend listening at http://0.0.0.0:${port}`);
});
