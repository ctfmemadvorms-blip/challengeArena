# ChallengeArena (live quiz)

    npm install && npm start     # http://localhost:3000   (npm test to run the suite)

- **Admin login**: set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in environment variables. They are required at startup; no credentials are stored in source control. On startup they create or synchronize the primary admin account and revoke that admin's existing sessions when changed.
- Participants: Register → Login → `/#/join` (sample quiz code `DEMO01`).
- Big screen: `/#/display` and enter the Display Code shown in the admin control room (press **T** to switch theme).
- Themes: **Tech Quiz** and **Spatial** (selector in the top bar).

## REST
POST /api/auth/login · GET/POST /api/quizzes · GET /api/quizzes/:id · POST /api/quizzes/:id/questions · DELETE /api/questions/:id · GET /api/join/:code (public)

## Socket events
Client→server: join_admin, join_screen, join_player, ADMIN_START_QUESTION, ADMIN_CLOSE, ADMIN_REVEAL, ADMIN_PAUSE, ADMIN_FINISH, PARTICIPANT_SUBMIT_ANSWER
Server→client: state, PARTICIPANT_JOINED, QUESTION_PUBLISHED, ANSWER_RECEIVED, QUESTION_CLOSED, ANSWER_RESULT_REVEALED, SCOREBOARD_UPDATED, QUIZ_PAUSED, QUIZ_FINISHED

Scoring is server-side: marks + up to 50% speed bonus; one answer per participant per question (UNIQUE constraint); correct option IDs are never sent before reveal.

## Tests
    npm install && npm test     # auth, quiz management, answer validation, scoring, live scoreboard (node:test + socket.io-client)

## Hosting
The app is one Node process (Express + Socket.IO), so it needs a host that supports **long-running servers and WebSockets**. It must run as a **single instance** (rooms and timers live in memory). Serverless hosts (Vercel/Netlify functions) will not work.

**Required env vars:** `JWT_SECRET` (long random string), `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `DATABASE_URL` (PostgreSQL connection string), and `NODE_ENV=production`. `PORT` is set by most hosts.

### Option A — Render (easiest)
1. Push the folder to a GitHub repo.
2. Render → New → Web Service → pick the repo. Runtime: Docker (uses the included Dockerfile).
3. Provision PostgreSQL and add the required env vars (including `DATABASE_URL`). Health check path: `/healthz`.
4. Deploy. Open the URL: admin at `/#/admin`, players at `/#/join`. HTTPS is automatic.
(Persistent disks need a paid instance; the free tier loses data on restart.)

### Option B — Railway / Fly.io
Same idea: deploy the Dockerfile, attach a volume at `/data`, set the env vars, keep 1 instance. Fly: `fly launch`, `fly volumes create data --size 1`, mount `/data` in fly.toml, `fly secrets set JWT_SECRET=...`.

### Option C — Your own VPS
    git clone <repo> && cd quiz-app && npm install --omit=dev
    export NODE_ENV=production JWT_SECRET=... ADMIN_USERNAME=... ADMIN_PASSWORD=... DATABASE_URL='postgresql://...'
    npm i -g pm2 && pm2 start server.js --name quiz
Put Nginx or Caddy in front for HTTPS (WebSocket upgrade headers required; Caddy `reverse_proxy localhost:3000` handles this automatically).

### Event-day checklist
- Open `/#/screen/CODE` on the projector and press F11 for full screen.
- Show the QR code from the admin control room (it encodes the join link).
- Test with a few phones on venue Wi-Fi first. For hundreds of players, use a larger instance; going beyond one instance needs Redis and the Socket.IO Redis adapter (not included).

## Categories, bulk add, live activation
- Every question has a **category** (use 3, e.g. Science / History / Technology). Control room → *Category scores* shows each player's points per category.
- **Bulk add**: paste lines `Category | Question | Correct | Wrong1 | Wrong2 | Wrong3` into the control room (see `sample-questions.txt`). Re-import any time to add more questions to an existing quiz; plan 30–40 total.
- **Pacing**: see *Question lifecycle* below (no timers).

## Capacity (50+ participants)
One instance comfortably handles 50–300 phones. Scoreboard pushes to admin/big screen are throttled (300 ms). To verify on your host: `node tests/load.js https://your-app.example.com 60` (simulates 60 players answering at once).

## Teams, hidden questions, shuffled options (new)
**Quiz configuration** (create form, editable on the control room until the quiz starts; locked afterwards):
- *Participation mode*: Individual (default for old quizzes) or Team, with team size 2–4 / exactly 2 / 3 / 4.
- *Question display*: **Big Screen only** (default for new quizzes) or Question + options on participants (legacy behaviour).

**Hidden question**: in Big-Screen-only mode the server never sends question text to participant sockets; each participant gets only option text in a server-shuffled order plus question number, time and status. Admin and `/#/screen/CODE` receive the full question.

**Shuffled options**: each participant (or team) gets a random option order stored server-side (`shuffles` table). Players submit a *display position*; the server translates it to the real option ID, so scoring is unaffected. The DB option order is never changed, and `is_correct` is never sent to participants (the correct answer is revealed only after the admin presses Reveal).

**Team flow**: join page → *Create a team* (enter quiz code, your name, team name) → leader gets a 5-character team code → members choose *Join a team* with quiz code + team code + their name. Team panel shows `Members n/max`; a team may play once it has the minimum members. Any member can pick an option (everyone sees each teammate's pick); only the **leader** can press **FINALIZE ANSWER**, which locks it. One score per team per question (speed bonus uses the finalize time). Leaderboard shows rank, team, members, correct, score, avg response time. Unfinalized teams score 0 for that question.

**New socket events**: `create_team`, `join_team`, `team_created`, `TEAM_ROSTER_UPDATED`, `TEAM_SELECT_ANSWER`, `TEAM_SELECTION_UPDATED`, `TEAM_FINALIZE`, `TEAM_ANSWER_FINALIZED`, `TEAM_MEMBER_DISCONNECTED` (team score changes arrive via `SCOREBOARD_UPDATED`). New REST: `PUT /api/quizzes/:id/settings`.

**Test**: `npm install && npm test`


## Question lifecycle, display code, team sizes (v3)
**The conductor controls everything — no timers, no pause, no auto-advance.**
`READY → [START QUESTION] → ACTIVE → [FINISH QUESTION] → FINISHED → [START NEXT QUESTION] → … → [FINISH QUIZ]`
- The control room shows one card: `Question n / N`, status (READY / ACTIVE / FINISHED), `Responses x / y` (+ "✓ All responses received" — it never auto-finishes), one primary button and **FINISH QUIZ** (confirmation dialog, permanent).
- Server rules: can't answer before start or after finish, can't start a question while one is active or after the quiz ended, can't finish a question twice, no more questions after the last. State is stored in `quizzes.current_index` / `question_status` / `status` so it survives restarts and reconnects.
- **Answers**: one per participant/team, locked immediately. The submitter (or the whole team) gets `participant:answer_result {pos, correct}`: the picked option turns **green** if correct, **red** if wrong; nothing else is revealed. After FINISH QUESTION players stay on the screen with their score/rank until the next question. Scoring = the question's marks for a correct answer (no speed bonus now that there is no timer); response time is still recorded for the leaderboard.
- **Big screen**: open `/#/display`, enter the **Display Code** shown in the control room. The display socket is read-only (cannot start/finish/modify anything, has no admin token, no access to admin APIs). It shows the question + canonical options when started, "QUESTION n FINISHED" afterwards, and the final leaderboard.
- **Team sizes**: tick any of Individual / 2 / 3 / 4 members. Only Individual → classic individual mode. Otherwise players *Create a team* (a team of 1 plays alone if size 1 is allowed) or *Join a team* with the team code. A team is *eligible* only when its member count is an allowed size; joining beyond the largest allowed size is rejected by the server. Settings lock once the quiz starts.
- **Events**: admin→server `admin:start_question`, `admin:finish_question`, `admin:finish_quiz`; display→server `display:connect`; server→clients `quiz:question_started`, `quiz:question_finished`, `quiz:finished`, `quiz:response_received`, `quiz:all_responses_received`, `display:connected`, `participant:answer_locked`, `participant:answer_result`, `team:member_joined`, `team:answer_updated`, `team:answer_finalized`, `team:member_disconnected`. Removed: close/reveal/pause/finish buttons and events, `QUESTION_PUBLISHED`, per-question timers.


## v4: accounts, roles, security (read before deploying)
**Roles**: `ADMIN` (manages only quizzes it created), `USER` (participant), `DISPLAY` (big screen, display code only). Team leader is a team permission, never a role. Public registration always creates `USER` (any `role` in the request is ignored). The primary admin comes from `ADMIN_USERNAME` / `ADMIN_PASSWORD`, never from public registration. Old `admin` rows are migrated to `ADMIN`.
**Participants sign in** (Register → Login → Join). Identity (user → participant → team) is derived server-side from the verified JWT; `participantId`/`teamId`/`score` in payloads are ignored. Join modes: *Play Individually* (no team field; in team-enabled quizzes that allow size 1 you get an auto "Solo · name" team), *Create Team* (name; server generates the code), *Join Team* (team code only).
**Names**: usernames and team names are normalized (NFKC, trim, collapse spaces, lowercase). Unique usernames (DB index), unique team names per quiz (DB index), and a team name may not equal any username (checked in both directions).
**Status codes**: 401 not authenticated, 403 wrong role, 404 not your quiz/question, 409 duplicate, 422 validation. Socket identity comes from `auth.token` at connect; every `admin:*` event re-checks role, account status, token version and quiz ownership; display sockets can never pass. `POST /api/auth/logout` revokes all of the user's tokens. Login is rate-limited (10 failures / 15 min per IP+login).
**Answer lock**: the browser locks all options and shows the pick *before* sending `{pos, sid}` and retries the same `sid` (every 3 s and on reconnect) until acknowledged. The server treats the same `sid` as the same answer and rejects a different `sid` once an answer exists; the DB enforces `UNIQUE(question_id, participant_id)` / `UNIQUE(question_id, team_id)`.
**Speed bonus** (server clock only): correct → `marks + round(marks × 0.5 × max(0, 1 − t / BONUS_WINDOW_SEC))`, t = server receive time − server question start time; wrong/none → 0. No countdown is shown.
**Images**: PNG/JPEG/WEBP ≤ 2 MB (PNG ≤ 4096²), type decided by magic bytes and must match the declared MIME; saved as `UPLOAD_DIR/questions/<uuid>.<ext>`, URL in `questions.image_url`, served `nosniff` with a restrictive CSP, deleted with the question/quiz. Sent to participants only in "Question + options" mode.
**Restart / Delete**: *Restart* (confirm) resets progress, responses, scores and shuffles and returns to READY, keeping quiz, questions, participants and teams. *Delete* (type the quiz code) removes everything incl. image files in one transaction.
**Migration notes**: columns/indexes are added automatically. If legacy data has team names that collide after normalization, `uq_team_norm` is skipped with a console warning (rename, restart). Old device-based participants remain as data; new play requires accounts.
**Known limitations**: `#/admin` is a client route (the page shell is public; all data is protected server-side). Tokens are in `localStorage` (XSS would expose them; no CSP on the app shell yet). Single process only (team selections/rate limits are in memory). No email verification or password reset.


## Changing the admin username/password
Set `ADMIN_USERNAME` / `ADMIN_PASSWORD` and restart: the server rewrites the primary admin's login on start and signs old admin sessions out. Admin usernames may contain `@`.

## v5: no-email registration, display shuffle, team answer privacy, themes
- **Registration** is username + password + confirm. Email is not collected or required (`users.email` stays as a nullable legacy column; the original admin keeps theirs and can still log in with it). Role is always `USER`; `role`/`isAdmin` in the request are ignored.
- **Display shuffle**: the big screen gets its own shuffled option order (stored per question, so it is stable across rerenders/reconnects and identical on every display of that quiz). Option "ids" sent to the display are positions only; the display never receives correctness or real option IDs. Participants keep independent orders; admins see the canonical order.
- **Team privacy**: a member's pick locks immediately and is sent only to that member's socket (`team:my_selection`; also `mySel` in that member's reconnect state). The team room only gets counts (`team:answer_updated {locked,total}`), member lists contain just `{name, leader}`. The leader sees nobody else's pick. Finalize submits the **leader's own locked pick** as the one team answer (teammates' picks are never stored, only the final team response). After finalization everyone on the team sees the team's result as before; wrong answers still never reveal the correct option.
- **Themes**: `Tech Quiz` (unchanged look, default) and `Spatial` (space background, orbit ring, glass cards, glow). One component set, styled by CSS variables under `[data-theme=…]`; choose in the top bar (or `?theme=spatial`, or press **T** on the display). Stored only in `localStorage.theme`; never sent to the server. CSS-only effects (no libraries), `prefers-reduced-motion` disables all animation, results are labelled "✓ Correct" / "✕ Incorrect" (not colour alone), focus outlines kept, option grid is 1 column on phones and 2 on the display.

## v7: buttons everywhere, no status badge, spatial UI + interactive backdrop
- **No connection badge.** The green "connected" / red "reconnecting…" badge and the "CONNECTED" display card are gone. The only connection message left is the inline "Connection lost — retrying…" shown while a player's answer is waiting to be delivered.
- **Buttons for every action and every navigation.** Top bar (Login / Register / Join / Display / Home / Logout), back buttons (← All quizzes, ← Dashboard, Back to login, Back), **Leave quiz / Back to home** for players, and on the admin side **Open big screen**, **Copy join code**, **Copy display code**, **Copy player link**. The big screen has a floating dock: **Theme · Effects · Fullscreen · Exit** (keys **T** and **F** still work).
- **Spatial is now the default theme** (Tech Quiz is still in the selector; saved choices are kept). Glass cards with 3D tilt and pointer-following light, glowing buttons, gradient headings, a second orbit ring, and a drifting nebula.
- **Interactive backdrop** (`<canvas id=fx>`, no libraries): parallax stars that follow the pointer, a constellation that links to the stars near the cursor, click/tap bursts, typing sparks, a warp-speed streak on page changes and when a question starts, green/red bursts on the answer you pick, a fireworks finish when the quiz ends, and occasional shooting stars. Tech Quiz gets a connected-network version of the same effect. **Effects: on/off** is in the top bar (saved in `localStorage.fx`); `prefers-reduced-motion` turns all of it off.

## v7.1: live top-2 scoreboard on the big screen
- The big-screen dock has a **Scoreboard** button (or press **S**). It slides a panel in from the right while the question stays visible beside it (the question area narrows to make room on wide screens; on small screens the panel overlays).
- Shows only the **top 2** (gold 🥇 Leader, silver 🥈 Runner-up) with name, team members, score and correct count. Updates live as answers arrive; a card pulses when its score changes. Before anyone has points it says "No points yet" instead of listing an arbitrary order. It hides itself when the quiz finishes (the full final leaderboard takes over).
- The on/off choice is remembered in `localStorage.sb`. No server change: the display already received the board.

## v7.2: Join / Display only in the admin's top bar
- Logged-out visitors see **Login · Register**; participants see **Home · Logout** (Home opens the join form); admins see **Dashboard · Display · Logout**. The public "Join" and "Display" buttons are gone.
- Admins hand players the join code / QR / player link and open the big screen from the control room (**Open big screen**, **Copy …** buttons). Direct links such as `/#/play/CODE` and `/#/display/CODE` still work, because the quiz code and display code are what protect them.

## v7.3: right/wrong is revealed only when the admin finishes the question
- While a question is active, a player's chosen option just turns into **🔒 Locked**. The server no longer sends `correct` in `participant:answer_result`, in the submit acknowledgement, or in the reconnect snapshot, so it cannot be read from the network either.
- When the admin presses **Finish question**, each player (and each team member) receives their own result in `quiz:question_finished` (`mine: {pos, correct}`) and the option flips to **✓ Correct** or **✕ Incorrect**, with the matching burst on the background. The tests assert both halves (hidden while active, revealed on finish).

## v7.4: PostgreSQL and Cloudflare Containers

The application now uses PostgreSQL through the required `DATABASE_URL` environment variable. Local SQLite files, `DB_FILE`, and `better-sqlite3` are no longer part of the runtime. This separates durable quiz data from the app container and works with any managed PostgreSQL provider (including one reached through Cloudflare Hyperdrive).

Admin access is now entirely environment-based: `ADMIN_USERNAME` and `ADMIN_PASSWORD` are required at startup, and `.env.example` shows the needed keys. The former source-controlled admin credential file was removed. Put real values only in `.env` locally or Cloudflare Worker secrets in production.

### Deploy on Cloudflare

`wrangler.jsonc` and `src/index.js` add a Cloudflare Container fronted by a Worker. The Worker forwards HTTP and WebSocket upgrade requests unchanged, so Socket.IO works without a separate proxy. One stateful container is intentional because Socket.IO rooms, timers, and team selections are held in memory; plain Workers/Pages functions cannot host this server by themselves.

1. Create a PostgreSQL database and obtain a TLS `DATABASE_URL` (normally with `sslmode=require`).
2. Install dependencies and authenticate: `npm install`, then `npx wrangler login`.
3. Store secrets, never in `wrangler.jsonc`: `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `DATABASE_URL` using `npx wrangler secret put NAME`.
4. With Docker running, deploy with `npm run cf:deploy`. For connected Git builds, use that command for the production deploy.

The included Docker image installs PostgreSQL's `libpq` client for `pg-native`. It listens on port 3000 and connects to PostgreSQL rather than a mounted database disk. Uploaded question images still use the container filesystem; use an R2 mount or object-storage adapter before treating uploads as durable across container replacement.

Existing `quiz.db` files are deliberately not imported automatically: moving real event data requires a reviewed one-time migration, rather than risking an accidental overwrite. A new PostgreSQL database is initialized with the sample quiz and the environment-configured admin on first start.
