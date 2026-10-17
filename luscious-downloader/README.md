# Luscious Downloader

A small app to browse and download albums from luscious.net. It has a web page and a command-line tool, and needs no packages beyond Node.js 18 or newer.

**18+ only.** Use it for your own personal archiving, and respect the site's terms and the creators' rights.

## Android app (APK)

Install on your phone from this link (open it on the phone):

**https://github.com/asyrel/twitch-chatgpt/releases/download/luscious-dl-latest/LusciousDL.apk**

Android will ask you to allow installing apps from your browser the first time. The app runs entirely on the phone, so no computer or server is needed. It can:

- separate **Hentai**, **Real** and **Manga** tabs (uses luscious.net's own content types and album types)
- hide gay (male/male), futa and furry albums by default, plus any tags you choose (Settings ⚙)
- a manga reader: right-to-left, left-to-right or long strip; tap zones and swipes; pinch and double-tap zoom; fit screen or width; page slider; preloading; keeps the screen on; remembers your page ("Continue reading"); reads saved albums offline
- **artist tools** (📚 Library):
  - *reference boards*: save single pages into named boards (Poses, Hands, Lighting…), kept offline with a link back to the album and uploader
  - *drawing study tools* in the viewer: mirror, grayscale, 4-tone value study, proportion grid (3×3 / 4×4 / 6×6), color palette and color picker (hex + HSV)
  - *gesture drawing practice*: timed random images (30s–10m) from a board, a section or your favorites, with skip/pause, volume-key skip and a session summary
  - *artist tracking*: follow uploaders or artist tags, see new albums since your last visit, keep private notes per artist
- show any user's favorites by profile link (like `https://www.luscious.net/users/123456/`), no password needed, filterable by Hentai / Real / Manga
- save albums to the **SD card** or phone, never shown in the Gallery (Settings ⚙ → Save downloads to):
  - *app folder* on SD card or phone: no setup, but removed if the app is uninstalled (updates are fine)
  - *a folder you choose*: kept after uninstalling; a `.nomedia` file keeps it out of the Gallery
- images are compressed losslessly while downloading by default (full size, identical pixels: PNGs become lossless WebP, JPEGs are kept as-is); smaller lossy options and Off in Settings. Pages are never cropped
- downloads run natively with a progress notification, so they keep going with the screen off
- tuned for the Samsung Galaxy A25: volume keys turn pages, full-screen reading, screen stays on, layout fits the notch and navigation bar

The APK is built by GitHub Actions (`.github/workflows/luscious-apk.yml`) on every push that changes `android-app/`. To build it yourself, install Android Studio, then run `npm install && npm run build:apk` in `android-app/`.

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
- **Sign in** with your luscious.net account and open **♥ Favorites** to see (and download) your favorited albums

### Signing in

Tap **Sign in** and enter your luscious.net username and password. Your password is sent only to luscious.net and is never saved. The app keeps only the login cookie, in `data/sessions.json` on the computer running it (git-ignored). **Sign out** deletes it.

If password sign-in doesn't work, the sign-in page has a fallback: sign in on luscious.net in a desktop browser, copy the `sessionid` cookie (developer tools → Application/Storage → Cookies) and paste it in.

luscious.net doesn't document how login and favorites work in its API, so the app works this out from the site's API when it runs. If sign-in or favorites fail, open your account page → **Troubleshooting info** and share what it shows.

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
