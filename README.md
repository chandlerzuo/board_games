# Board Games

A property-and-siege board game in the style of the original *三國風雲*. It recreates the original board, rule book, poker cards, event cards and territory deeds, and can be played in several themes.

## Themes

Every theme uses the same rules, prices, tolls and card strengths. A theme only changes names and pictures: the board, the place names, the characters on the poker cards, the names of some special and strategy cards, and the page title.

| Theme | Key | Setting | Commanders (the four aces) | Event decks |
|---|---|---|---|---|
| 三國風雲 | `sanguo` | Three Kingdoms (*三國演義*) | 曹操、劉備、孫權、董卓 | 緊急軍情 / 錦囊妙計 |
| 水滸風雲 | `shuihu` | Water Margin (*水滸傳*) | 宋江、盧俊義、晁蓋、方臘 | 江湖告急 / 智取妙計 |

Pick the theme on the offline setup screen, or as host in the online lobby. The four 2-cards (咸蛋超人、黑武士、機器戰警、蝙蝠俠) are not historical figures and are the same in every theme.

### Adding a theme

1. **`themes.js`**: add an entry to `THEMES` and its key to `order`. Give it a `label`, `sub` (subtitle), `board` file name, `tiles` (all 55 square names, in the same order as `TILES` in `engine.js`), and optional `cards` (card code → character name), `strategy` (strategy-card key → name) and `kinds` (e.g. `overlord` → joker-card name). Anything not listed keeps the Sanguo name.
2. **Board**: add the theme to the theme lists in `tools/make_board_svg.py` (`load_theme_names` and the loop at the bottom), then run `python3 tools/make_board_svg.py` to write `board-<key>.svg`.
3. **Card art (optional)**: write a `theme-<key>-art.js` that calls `registerCardTheme('<key>', { fig, text, art })`, like `theme-shuihu-art.js`, and load it in `index.html` after `cards.js`. Cards it does not cover use the Sanguo art.
4. **Online play**: add the new board and art files to `FILES` in `server/server.js`. The server only sends files listed there.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page markup and styles |
| `engine.js` | Rules engine (no UI). Runs in the browser for offline play and in Node for online play |
| `client.js` | Board, side panel, dialogs and hover tips; the offline and online adapters |
| `cards.js` | SVG artwork for the 54 poker cards |
| `themes.js` | Theme data: square names, character names and card names for each theme |
| `theme-shuihu-art.js` | Water Margin card portraits, descriptions and special-card art |
| `board-sanguo.svg`, `board-shuihu.svg` | One board per theme |
| `tools/make_board_svg.py` | Generates the board files from the names in `themes.js` |
| `server/server.js` | Online game server (Node.js, no dependencies) |
| `server/form.js` | Lets the server read answers to dialogs that contain form fields |

## Play offline (one computer)

Open `index.html` directly in a browser. Each seat can be a human or the computer; several humans can share one screen (the game asks you to pass the device before showing private cards). Pick the theme on the setup screen, or open `index.html?theme=shuihu` to start with Water Margin selected. `index.html?demo` runs a computer-only game; add `&theme=shuihu` for Water Margin.

## Play online (local test)

```sh
node server/server.js          # or SANGUO_PORT=9000 node server/server.js
```

Open <http://127.0.0.1:8765/> in several browser tabs or windows. Each tab is a separate player (the seat is remembered per tab, so reloading keeps your seat). The first player to join is the host, who can turn empty seats into computer players, choose the theme and start the game.

The game engine runs on the server, and each browser receives only that player's own view: your own hand, the public parts of the board, and cards you remember from public captures. Opponents' hands never reach your browser.

### Why it only runs on 127.0.0.1

This version has no login. The per-tab seat code only links a browser tab to a seat; it does not prove who someone is. The server therefore refuses to listen on anything other than `127.0.0.1` / `::1` / `localhost` (setting `SANGUO_HOST=0.0.0.0` makes it exit with an error).

### Before friends on other computers can join

1. **Host it on a personal account, not a corporate machine.** For example a personal cloud account or a hosting service that runs Node.js. Do not expose it from a work laptop or Cloud Desktop.
2. **Add a real sign-in** from the hosting platform or an identity provider (for example "Sign in with Google"), so each seat is tied to a verified account. Do not use home-made passwords or shared room codes.
3. **Serve it over HTTPS only.**
4. **Map signed-in accounts to seats** in `server/server.js` (`/api/join` and `seatByToken`) instead of the per-tab code, and only then allow a non-loopback listen address.
