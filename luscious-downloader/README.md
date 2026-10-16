# Luscious Downloader

A small app to browse and download albums from luscious.net. It has a web page and a command-line tool, and needs no packages beyond Node.js 18 or newer.

**18+ only.** Use it for your own personal archiving, and respect the site's terms and the creators' rights.

## Web app

```bash
cd luscious-downloader
npm start            # or: node server.js
```

Open http://localhost:3000. You can:

- search albums (or browse trending, newest, top rated)
- paste an album link to open it directly
- view every picture full screen (swipe or arrow keys)
- tap **Download ZIP** to get the whole album as one `.zip`

To open it from your phone on the same Wi-Fi, run `HOST=0.0.0.0 npm start` and visit `http://<your-computer-ip>:3000`. Change the port with `PORT=8080`.

## Command line

```bash
node cli.js https://www.luscious.net/albums/some-title_123456/
node cli.js 123456 654321 --out ~/Pictures/luscious --jobs 6
```

Files are saved as `downloads/<Album title> (<id>)/001_name.jpg`, … Run the same command again to resume: files already downloaded are skipped.

## Notes

- It uses the same public GraphQL API the website uses. If the site changes it, set `LUSCIOUS_API` to a different endpoint (default `https://members.luscious.net/graphql/nobatch/`).
- Images are loaded through the local server (`/img`), which only proxies `*.luscious.net` URLs.
- ZIP downloads are uncompressed (images are already compressed) and limited to 4 GB.
