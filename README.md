# Dev First Mate — Personal Agent

**GitHub + npm cross-source intelligence, powered entirely by Coral SQL.**

This application provides a daily briefing dashboard that aggregates your GitHub activity and npm package data into a single view, helping you prioritize work, track repository health, and monitor CI/CD status — all powered by Coral's unified SQL interface.

<img width="1467" height="886" alt="image" src="https://github.com/user-attachments/assets/6676cddd-ed86-4851-a0fd-626048e29818" />

## What This App Does

- **Queries GitHub & npm data** via Coral SQL (no direct API keys needed — Coral handles auth, pagination, rate limits)
- **Aggregates insights** across your public/private repositories, issues, notifications, and npm packages
- **Generates a prioritized briefing** showing:
  - High-priority items (failing CI builds)
  - Medium-priority items (open issues assigned to you)
  - Low/Info priority (active/recent/stale repositories)
  - Language breakdown and npm download statistics
- **Updates automatically** as Coral syncs with your GitHub.com and npm accounts (note: Coral syncs periodically, so there may be a few-minute delay between pushing changes and seeing them in the dashboard)

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- [Coral CLI](https://github.com/withcoral/coral) installed and configured with your GitHub and npm sources
  - Verify: `coral source list` should show `github` and `npm` sources
  - If you haven't set up Coral yet, see the [Coral Quickstart](https://github.com/withcoral/coral#quickstart)

## Installation

From the coral folder:

```bash
# Install Node.js dependencies (Express for the web UI)
npm install
```

## Running the CLI Agent

To see the same terminal-based dashboard as in the screenshot:

```bash
node agent.js
```

For JSON output (useful for scripting or integration):

```bash
node agent.js --json
```

## Running the Web UI

To run the dashboard in a browser on any port:

```bash
# Start the Express server
node server.js
# or via npm
npm start
```

Then open your browser to:
- `http://localhost:3000/` – Text dashboard (matches `node agent.js` output)
- `http://localhost:3000/json` – Raw JSON data
- `http://localhost:3000/health` – Health check endpoint

To run on a custom port, set the `PORT` environment variable:

```bash
PORT=8080 node server.js   # Access at http://localhost:8080/
```

## Using Coral SQL Directly

You can query the underlying data with the Coral CLI. Examples:

### GitHub Profile
```bash
coral sql "SELECT login, name, public_repos, followers, following, created_at FROM github.user" --format json
```

### Recent Repositories
```bash
coral sql "SELECT name, language, stargazers_count, forks_count, open_issues_count, updated_at, visibility, fork, description FROM github.user_repos ORDER BY updated_at DESC" --format json
```

### Language Breakdown
```bash
coral sql "SELECT language, COUNT(*) as repo_count, SUM(stargazers_count) as total_stars FROM github.user_repos WHERE language IS NOT NULL AND fork = false GROUP BY language ORDER BY repo_count DESC LIMIT 10" --format json
```

### Open Issues Assigned to You
```bash
coral sql "SELECT number, title, state, created_at, repository_url FROM github.issues WHERE state = 'open' LIMIT 20" --format json
```

### Unread Notifications
```bash
coral sql "SELECT id, reason, unread, subject__title, subject__type, repository__full_name, updated_at FROM github.notifications WHERE unread = true ORDER BY updated_at DESC LIMIT 30" --format json
```

### NPM Package Info
```bash
coral sql "SELECT name, version, description, license, homepage, repository_url FROM npm.package_info WHERE package_name='<package-name>'" --format json
```

### NPM Download Statistics
```bash
coral sql "SELECT package_name, downloads, start, end FROM npm_stats.downloads WHERE package_name='<package-name>'" --format json
```

## Understanding the Data Refresh Interval

Coral synchronizes with your GitHub.com and npm accounts **periodically** (not in real time). When you run `node agent.js` or visit the web UI, you are seeing data as of Coral's last sync cycle.

- **To see recent changes**: Push commits to GitHub.com, then wait a few minutes for Coral to sync before re-running the agent.
- **Typical sync delay**: Based on testing, Coral's sync interval appears to be on the order of several minutes (observed >6.5 minutes for issue creation in our tests — your mileage may vary).

If you need the most current data, you can force a Coral source refresh (if supported by your Coral version) or simply wait for the next periodic sync.

## Project Structure

```
coral/
├── agent.js                 # Core logic: CLI agent + Coral SQL queries
├── server.js                # Express web UI wrapper (exports same data as agent.js)
├── Personal-Dev-Intelligence-Agent/
│   └── agent.js             # Original CLI agent (same as root agent.js for convenience)
├── package.json             # Node.js dependencies (express) and scripts
├── README.md                # This file
└── Screenshot 2026-05-18 at 6.45.03 PM.png  # Example UI output
```

## How It Works Under the Hood

1. The `sql()` function in `agent.js` executes Coral SQL queries via the Coral CLI binary.
2. Queries join data from GitHub (repos, issues, notifications, starred) and npm (packages, downloads).
3. Post-processing layers (`analyzeRepos`, `buildPriorities`, etc.) derive insights like:
   - Active vs. stale repositories (based on `updated_at`)
   - Failing CI builds (from notifications with reason `ci_activity` and failure indicators)
   - Language statistics
   - npm download totals
4. The CLI (`node agent.js`) formats this into a terminal dashboard.
5. The web UI (`server.js`) reuses the same `runBriefing()` function and serves the formatted text as plain text over HTTP.

## Troubleshooting

- **"Coral command not found"**: Ensure Coral is installed and in your PATH (`which coral` should return a path).
- **Authentication errors**: Verify Coral has valid GitHub and npm tokens configured (`coral source update --token <PAT> github` etc.).
- **No data returned**: Check that Coral has sources configured (`coral source list`) and that your GitHub account has public/private repos.
- **Port already in use**: Kill existing processes on the port or specify a different `PORT`.

## License

ISC – same as the original agent.js.

---

*Built with Coral SQL — turning APIs, databases, and files into queryable tables without writing glue code.*
