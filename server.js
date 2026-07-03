const express = require('express');
const ytSearch = require('yt-search');

const app = express();
const port = process.env.PORT || 3000;

app.get('/ping', (req, res) => {
  res.json({ status: 'ok', message: 'SoundStudio backend is awake' });
});

app.get('/search', async (req, res) => {
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

    const videos = searchResult.videos.slice(0, 25).map(video => {
      const videoId = video.videoId;
      const thumbnail = video.thumbnail || video.image || '';
      return {
        videoId,
        title: video.title,
        thumbnail,
        duration: (video.seconds || 0) * 1000,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    });

    return res.json(videos);
  } catch (err) {
    console.error(`Error in /search route: ${err}`);
    return res.status(500).json({ error: 'Failed to search YouTube', details: err.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`SoundStudio backend listening at http://0.0.0.0:${port}`);
});
