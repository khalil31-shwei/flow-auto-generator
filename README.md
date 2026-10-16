# Google Flow Automated Image Generator

A robust, production-grade Node.js Puppeteer project designed to automate image generation and downloading on Google Flow (`https://flow.google.com/`). Every launch automatically creates a fresh project workspace and stores outputs into timestamped session directories.

---

## 🌟 Key Architecture & Multi-Layered Extraction

1. **Zero "Blank Page" Browser Launch:**
   - Launches Chrome using `puppeteer.launch({ headless: false, defaultViewport: null, userDataDir: './chrome_user_data', args: ['--start-maximized', '--no-default-browser-check'] })`.
   - Explicitly avoids port `9222` and `puppeteer.connect`.
   - Uses the initial opened tab (`(await browser.pages())[0]`) rather than opening a new tab, and automatically closes any unwanted extra or blank tabs.

2. **Automatic Fresh Project Creation:**
   - Navigates to the Google Flow Dashboard (`https://flow.google.com/` or `https://labs.google/fx/tools/flow`).
   - Automatically searches the DOM and all Shadow Roots for the "New Project" / "Create" / "+" button.
   - Automatically clicks the button and waits for the newly generated `/project/...` URL to load.
   - **Interactive Fallback:** If the button is not automatically detected within 12 seconds, prompts the user in the terminal and waits until the browser URL contains `/project/`.

3. **Timestamped Session Storage:**
   - Each run creates a dedicated, timestamped folder under `downloaded_images/` (e.g. `downloaded_images/session_YYYY-MM-DD_HH-mm-ss/`).
   - Images from different runs never collide, mix, or overwrite each other.

4. **Native CDP Download Behavior:**
   - Enables Chrome DevTools Protocol (`Page.setDownloadBehavior`) right at browser launch so any native download button or download link automatically saves files directly into the active session folder.

5. **Multi-Layered Bulletproof Image Extraction:**
   - **Layer 1: Native UI Download Trigger:** Clicks the card's native download button/icon in Google Flow, capturing the full-resolution file via CDP into the session directory and auto-renaming it to `prompt_XX_img_Y.png`.
   - **Layer 2: Deep DOM In-Browser Fetch & Blob Conversion:** Recursively traverses shadow roots, custom elements, `<canvas>`, and background images to fetch and convert image data.
   - **Layer 3: Direct Element Compositor Screenshot:** Takes a direct Puppeteer screenshot (`handle.screenshot()`) of the image element or card, completely immune to CORS, canvas security restrictions, or opaque responses.
   - **Layer 4: Network Response Interceptor:** Intercepts raw image HTTP response buffers (`image/png`, `image/webp`, `googleusercontent.com`) directly from Chrome's network stream.
   - **Layer 5: Viewport Fallback Snapshot:** Captures the workspace card area as a final safety net.

6. **100% Automatic Hands-Free Submission:**
   - Actively focuses the input element.
   - Dispatches DOM `keydown`, `keypress`, and `keyup` Enter events with `keyCode: 13`.
   - Fires `page.keyboard.press('Enter')`.
   - **Crucial Button Click Fallback:** Verifies submission status within 1.5 seconds; if text remains or generation hasn't started, finds and clicks the Send / Generate / Arrow button in the prompt toolbar.

7. **Automatic Parameter Setup:**
   - Automatically detects and targets aspect ratio (`3:4` or `1:1`) and batch size (`x3` or `3`).
   - Includes a 15-second setup pause and a 10-second lock-in buffer window to review and freeze custom workspace toggles.

---

## 🚀 Quick Start

### 1. Run the Bot
```bash
npm start
```
or
```bash
node bot.js
```

### 2. First Run (Login)
- On the first run, if you are not already logged into Google in this profile, Chrome will navigate to the sign-in page.
- Sign in to your Google Account.
- Your session is permanently saved in `./chrome_user_data`, so you won't need to sign in again on future runs.

### 3. Customize Prompts
- Edit `prompts.txt` to add, remove, or modify prompts (one prompt per line).
- Category headers (e.g. `(1-10)`) and lines starting with `#` are automatically ignored.

---

## 📁 Project Structure

```
├── bot.js               # Main automation script
├── prompts.txt          # Pre-configured image prompts
├── downloaded_images/   # Directory containing timestamped session folders
│   └── session_YYYY-MM-DD_HH-mm-ss/
├── chrome_user_data/    # Chrome user profile (persists Google login session)
├── package.json         # Project configuration and dependencies
└── README.md            # Documentation
```
