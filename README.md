# Movin' Up notifications: the sender (phase 2)

A small scheduled job. Every 10 minutes GitHub Actions runs `send.js`, which reads the app's Firestore with a service account and
sends pushes through Firebase Cloud Messaging (free). It sends:

- **Friend requests**: "X wants to be your friend." to the person who was asked.
- **Challenge updates**: an invite to each invited friend; "started" to everyone when the last person accepts; "complete" and
  "called off" to everyone in the challenge.
- **Cheers** (v2.0.37, also under "Challenge updates"): "@name cheered you on" to the friend who was cheered on a running walk.
  The sender reads each running challenge's `cheers` subcollection and remembers where it stopped, so a cheer is announced once.
- **Daily reminders** (water, steps, log food): once a day at the time each person picked, in their own time zone.

Each person only gets what they switched on in Settings > Notifications. Nothing here can read anyone's food, weight, steps or
workouts: it only reads `pushDevices` (their choices and phone addresses), `friendRequests`, `challenges` (and their `cheers`) and `usernames`.

## Put it online (one time)

1. **Make a new PUBLIC repository** on GitHub (any name, for example `movinup-notify`). Public matters: private repos only get 2,000
   free Actions minutes a month and this job needs about 4,300. It holds no secrets, only this folder.
2. **Upload everything inside this `notify/` folder** to the repository root, including the hidden `.github` folder (so that
   `.github/workflows/notify.yml` exists in the repo). Do NOT upload `node_modules`.
3. **Make a service account key.** Firebase console > Project settings > Service accounts > Generate new private key. A `.json` file
   downloads. Keep it private. Never put it in the repo or send it to anyone.
4. **Save it as a secret.** GitHub repo > Settings > Secrets and variables > Actions > New repository secret. Name it exactly
   `FIREBASE_SERVICE_ACCOUNT`, paste the **whole contents** of the `.json` file, save. Then delete the downloaded file.
5. **Turn it on.** Repo > Actions tab. If GitHub asks, click "I understand my workflows, go ahead and enable them".

## Check that it works

1. Phone: open the app, Settings > Notifications > Turn on notifications (allow it).
2. Repo > Actions > "Send notifications" > Run workflow. Type your **username** in the first box and run. A test push
   ("Test from movin' up") should reach your phone within seconds. If it did, everything works.
3. A normal pass can be run the same way with the box left empty. Tick "Dry run" to see what would be sent without sending.

The schedule then runs by itself. The log of each run (open it in the Actions tab) says how many friend requests, challenge events and
reminders it found and how many pushes went out.

## Good to know

- **Delays.** GitHub's scheduler often starts a few minutes late, so reminders and friend alerts can arrive a bit after their time.
  A reminder is skipped, not sent late, if more than 45 minutes have passed.
- **Reminders** are skipped for today if you switch one on (or change its time) after that time has already passed.
- **Phones that stop working** (app uninstalled, notifications revoked) are removed from the account automatically.
- **Keep-alive.** GitHub turns off scheduled jobs in a public repo after 60 days with no activity. The last step of the workflow resets
  that clock on every run, so you should not need to do anything. If you ever see "This scheduled workflow is disabled", open the
  Actions tab and click Enable.
- **Free limits.** Each pass reads every notification-enabled account once (about 144 passes a day). That is far inside the Firebase
  free plan (50,000 reads a day) for hundreds of people. If the app ever has thousands of users with notifications on, slow the
  schedule to every 15 or 30 minutes in `notify.yml`.
- **What it remembers.** `pushState/_global` (what the last pass saw, so nothing is announced twice) and `pushState/{uid}` (the day
  each reminder last went out). No rules are needed: nobody but the service account can read or write `pushState`.
- **Try it on your computer.** `npm ci`, put the key file's path in `GOOGLE_APPLICATION_CREDENTIALS`, then `node send.js --dry`.
- **Route names.** `routes.json` turns a route id into its name ("milford" into "Milford Track"). It is rebuilt from the app with
  `node notify/make-routes.js` (run from the app project); the app's tests fail if it is out of date.
