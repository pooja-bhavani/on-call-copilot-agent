const express = require('express');
const { execFile } = require('child_process');
const { formatBriefing, Q } = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;
const CORAL = process.env.CORAL_BIN || 'coral';
const SQL_TIMEOUT_MS = Number(process.env.CORAL_SQL_TIMEOUT_MS || 90000);

app.use(express.json());

const DASHBOARD_QUERIES = {
  profile: Q.profile,
  repos: Q.repos,
  languages: Q.languages,
  issues: Q.issues,
  notifications: Q.notifications,
  starred: Q.starred,
  npmSearch: "SELECT name, version, downloads_monthly, description, npm_url FROM npm.search WHERE q='author:pooja-bhavani' LIMIT 20",
};

function coralSql(query) {
  const cleanQuery = query.replace(/\s+/g, ' ').trim();
  return new Promise((resolve) => {
    execFile(
      CORAL,
      ['sql', cleanQuery, '--format', 'json'],
      {
        encoding: 'utf8',
        timeout: SQL_TIMEOUT_MS,
        env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            query: cleanQuery,
            rows: [],
            error: (stderr || stdout || error.message || 'Coral SQL failed').trim().split('\n')[0],
          });
          return;
        }

        try {
          resolve({ ok: true, query: cleanQuery, rows: JSON.parse(stdout.trim() || '[]') });
        } catch (parseError) {
          resolve({ ok: false, query: cleanQuery, rows: [], error: parseError.message, raw: stdout });
        }
      },
    );
  });
}

function analyzeRepos(repos) {
  const now = Date.now();
  const d30 = now - 30 * 86400000;
  const d90 = now - 90 * 86400000;
  const ownRepos = repos.filter(repo => !repo.fork);
  return {
    total: repos.length,
    ownRepos,
    active: ownRepos.filter(repo => new Date(repo.updated_at).getTime() > d30),
    stale: ownRepos.filter(repo => new Date(repo.updated_at).getTime() < d90),
    starred: ownRepos.filter(repo => repo.stargazers_count > 0).sort((a, b) => b.stargazers_count - a.stargazers_count),
  };
}

function analyzeNotifications(notifications) {
  const failedCI = notifications.filter(item =>
    item.reason === 'ci_activity' && String(item.subject__title || '').toLowerCase().includes('fail')
  );
  return { failedCI, total: notifications.length };
}

function buildPriorities(repoA, notifA, issues) {
  const priorities = [];
  if (notifA.failedCI.length) {
    const repos = [...new Set(notifA.failedCI.map(item => item.repository__full_name).filter(Boolean))];
    priorities.push({ level: 'high', icon: '🔴', title: `Fix failing CI in ${repos.length} repo(s)`, detail: repos.join(', ') });
  }
  if (issues.length) {
    priorities.push({ level: 'medium', icon: '🟡', title: `${issues.length} open issue(s) assigned to you`, detail: issues.slice(0, 3).map(item => `#${item.number} ${item.title}`).join(' · ') });
  }
  if (repoA.active.length) {
    priorities.push({ level: 'low', icon: '🟢', title: `${repoA.active.length} active repo(s) this month`, detail: repoA.active.slice(0, 3).map(item => item.name).join(', ') });
  }
  if (repoA.stale.length) {
    priorities.push({ level: 'info', icon: '⚪', title: `${repoA.stale.length} repo(s) untouched for 90+ days`, detail: repoA.stale.slice(0, 3).map(item => item.name).join(', ') });
  }
  return priorities;
}

async function getDashboardData() {
  const entries = Object.entries(DASHBOARD_QUERIES);
  const results = await Promise.all(entries.map(async ([key, query]) => [key, await coralSql(query)]));
  const resultMap = Object.fromEntries(results);

  const profile = resultMap.profile.rows;
  const repos = resultMap.repos.rows;
  const languages = resultMap.languages.rows;
  const issues = resultMap.issues.rows;
  const notifications = resultMap.notifications.rows;
  const starred = resultMap.starred.rows;
  const npmSearch = resultMap.npmSearch.rows;

  const user = Array.isArray(profile) ? profile[0] || {} : {};
  const repoA = analyzeRepos(Array.isArray(repos) ? repos : []);
  const notifA = analyzeNotifications(Array.isArray(notifications) ? notifications : []);
  const errors = Object.entries(resultMap)
    .filter(([, result]) => !result.ok)
    .map(([source, result]) => ({ source, error: result.error, query: result.query }));

  return {
    generatedAt: new Date().toISOString(),
    mode: errors.length ? 'live-with-errors' : 'live',
    user,
    summary: {
      totalRepos: repoA.total,
      ownRepos: repoA.ownRepos.length,
      activeRepos: repoA.active.length,
      staleRepos: repoA.stale.length,
      openIssues: Array.isArray(issues) ? issues.length : 0,
      unreadNotifications: notifA.total,
      failedCICount: notifA.failedCI.length,
      followers: user.followers || 0,
      npmPackagesFound: Array.isArray(npmSearch) ? npmSearch.length : 0,
      totalNpmDownloads: Array.isArray(npmSearch)
        ? npmSearch.reduce((sum, item) => sum + Number(item.downloads_monthly || 0), 0)
        : 0,
    },
    priorities: buildPriorities(repoA, notifA, Array.isArray(issues) ? issues : []),
    recentRepos: repoA.active.slice(0, 8),
    staleRepos: repoA.stale.slice(0, 5),
    topStarred: repoA.starred.slice(0, 5),
    languages: Array.isArray(languages) ? languages : [],
    issues: Array.isArray(issues) ? issues : [],
    notifications: Array.isArray(notifications) ? notifications.slice(0, 15) : [],
    failedCI: notifA.failedCI,
    ciDetails: {},
    starredRepos: Array.isArray(starred) ? starred.slice(0, 8) : [],
    npm: {
      authorPackages: Array.isArray(npmSearch) ? npmSearch.slice(0, 10) : [],
      packageDetails: {},
      downloads: {},
      totalDownloads: Array.isArray(npmSearch)
        ? npmSearch.reduce((sum, item) => sum + Number(item.downloads_monthly || 0), 0)
        : 0,
    },
    queryResult: Array.isArray(repos) ? repos.slice(0, 10) : [],
    queries: {
      repos: 'SELECT name, language, stargazers_count, updated_at FROM github.user_repos ORDER BY updated_at DESC LIMIT 10',
      issues: Q.issues,
      notifications: Q.notifications,
      languages: Q.languages,
      starred: Q.starred,
      npm: DASHBOARD_QUERIES.npmSearch,
    },
    queryHealth: resultMap,
    errors,
  };
}

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dev First Mate</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #10151d; --panel: #171c24; --panel-2: #20252e; --line: #2a303a;
      --text: #d8dee9; --muted: #8d96a5; --blue: #5aa2f7; --red: #f05d44;
      --yellow: #e4bd45; --green: #5ebd50; --orange: #ef835e;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: #090b0f; color: var(--text); font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, textarea { font: inherit; }
    .shell { min-height: 100vh; background: var(--bg); border: 1px solid #26303a; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 22px; border-bottom: 1px solid var(--line); background: #12171f; }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 220px; }
    .logo { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; background: #f2f4f8; color: #0e1218; font-size: 18px; }
    h1 { margin: 0; font-size: 20px; line-height: 1.1; }
    .powered { margin-top: 3px; color: var(--muted); font-size: 12px; font-weight: 700; }
    .powered span { color: #ff866d; }
    .account { display: flex; align-items: center; gap: 12px; color: var(--muted); font-weight: 700; }
    .refresh { border: 1px solid var(--line); background: var(--panel-2); color: var(--text); border-radius: 7px; padding: 8px 12px; cursor: pointer; font-weight: 800; }
    .pills { display: flex; flex-wrap: wrap; gap: 10px; padding: 12px 22px; border-bottom: 1px solid var(--line); }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 999px; background: #232932; border: 1px solid var(--line); color: var(--muted); font-size: 13px; font-weight: 800; }
    .pill.red { color: #ff705e; background: rgba(240,93,68,.14); border-color: rgba(240,93,68,.28); }
    .pill.yellow { color: #f2c84f; background: rgba(228,189,69,.13); border-color: rgba(228,189,69,.26); }
    .pill.green { color: #69d45c; background: rgba(94,189,80,.13); border-color: rgba(94,189,80,.26); }
    .dot { width: 12px; height: 12px; border-radius: 50%; background: currentColor; box-shadow: 0 0 14px currentColor; }
    .metrics { display: grid; grid-template-columns: repeat(7, minmax(100px, 1fr)); border-bottom: 1px solid var(--line); }
    .metric { min-height: 92px; display: grid; place-items: center; align-content: center; gap: 8px; border-right: 1px solid var(--line); }
    .metric:last-child { border-right: 0; }
    .num { font-size: 30px; font-weight: 900; letter-spacing: 0; }
    .metric label { color: var(--muted); text-transform: uppercase; font-size: 11px; font-weight: 900; letter-spacing: .08em; }
    .green { color: var(--green); } .yellow { color: var(--yellow); } .red { color: var(--red); } .blue { color: #6ba6ff; }
    .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; padding: 18px 22px 26px; }
    .stack { display: grid; gap: 16px; align-content: start; }
    .card { overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .card h2 { display: flex; align-items: center; justify-content: space-between; margin: 0; padding: 13px 16px; background: var(--panel-2); font-size: 15px; }
    .count { min-width: 24px; height: 24px; display: inline-grid; place-items: center; border-radius: 999px; background: #11151d; color: var(--muted); font-size: 12px; }
    .list { padding: 8px 16px 12px; }
    .row { display: grid; gap: 2px; padding: 11px 0; border-bottom: 1px solid #272d36; }
    .row:last-child { border-bottom: 0; }
    .name { color: var(--blue); font-weight: 850; }
    .meta { color: var(--muted); font-size: 12px; font-weight: 700; }
    .repo-row { grid-template-columns: 1fr auto auto; align-items: center; column-gap: 10px; }
    .language-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--orange); }
    .star { color: #ffd15c; font-size: 13px; font-weight: 900; }
    .lang { display: grid; grid-template-columns: 110px 1fr 72px; gap: 10px; align-items: center; padding: 8px 0; }
    .bar { height: 7px; overflow: hidden; border-radius: 999px; background: #222831; }
    .fill { height: 100%; border-radius: inherit; background: var(--blue); }
    .query-tabs { display: flex; gap: 7px; padding: 12px 16px 0; flex-wrap: wrap; }
    .tab { border: 0; border-radius: 5px; padding: 6px 10px; background: #2a3039; color: var(--muted); cursor: pointer; font-size: 12px; font-weight: 900; }
    .tab.active { color: var(--text); background: #343b46; }
    textarea { width: calc(100% - 32px); min-height: 86px; margin: 12px 16px; padding: 13px; resize: vertical; border: 1px solid #303742; border-radius: 7px; background: #222832; color: var(--text); font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .run { width: calc(100% - 32px); margin: 0 16px 12px; border: 0; border-radius: 7px; padding: 11px 14px; background: var(--orange); color: white; cursor: pointer; font-weight: 900; }
    pre { max-height: 250px; margin: 0 16px 16px; padding: 14px; overflow: auto; border-radius: 7px; background: #20262f; color: #79d279; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; }
    .danger { color: #ff4f41; font-size: 20px; font-weight: 900; }
    .error { color: #ff9a8a; }
    @media (max-width: 1180px) { .grid { grid-template-columns: 1fr 1fr; } .metrics { grid-template-columns: repeat(4, 1fr); } }
    @media (max-width: 760px) { .topbar, .account { align-items: flex-start; flex-direction: column; } .metrics, .grid { grid-template-columns: 1fr; } .metric { border-right: 0; border-bottom: 1px solid var(--line); } .lang { grid-template-columns: 88px 1fr 56px; } }
  </style>
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div class="brand"><div class="logo">🧭</div><div><h1>Dev First Mate</h1><div class="powered">Powered by <span>Coral SQL</span></div></div></div>
      <div class="account"><span id="account">@loading</span><span id="repoCount">Loading repos</span><span id="followers">Loading followers</span><button class="refresh" id="refresh">↻ Refresh</button></div>
    </section>
    <section class="pills" id="pills"><span class="pill"><span class="dot"></span>Loading live Coral SQL...</span></section>
    <section class="metrics" id="metrics"></section>
    <section class="grid">
      <div class="stack"><article class="card"><h2>🔥 Active Repos <span class="count" id="activeCount">0</span></h2><div class="list" id="activeRepos"></div></article><article class="card"><h2>⚙️ CI Status</h2><div class="list" id="ciStatus"></div></article></div>
      <div class="stack"><article class="card"><h2>📊 Languages</h2><div class="list" id="languages"></div></article><article class="card"><h2>🔔 Notifications <span class="count" id="notificationCount">0</span></h2><div class="list" id="notifications"></div></article></div>
      <div class="stack"><article class="card"><h2>🪸 Coral SQL Explorer</h2><div class="query-tabs" id="queryTabs"></div><textarea id="query"></textarea><button class="run" id="run">▶ Run Query</button><pre id="result">Loading live data from Coral SQL...</pre></article><article class="card"><h2>⭐ Starred Repos</h2><div class="list" id="starred"></div></article></div>
    </section>
  </main>
  <script>
    const defaultQueries = ${JSON.stringify({
      repos: 'SELECT name, language, stargazers_count, updated_at FROM github.user_repos ORDER BY updated_at DESC LIMIT 10',
      issues: Q.issues,
      notifications: Q.notifications,
      languages: Q.languages,
      starred: Q.starred,
      npm: DASHBOARD_QUERIES.npmSearch,
    })};
    const colors = ['#ef835e', '#5aa2f7', '#6ba6ff', '#8a62d6', '#71848e', '#f1dd5c', '#9be564', '#7655b7', '#5db8d7', '#aab2bf'];
    const metricMap = [['totalRepos','TOTAL REPOS',''],['activeRepos','ACTIVE (30D)','green'],['staleRepos','STALE (90D+)','yellow'],['openIssues','OPEN ISSUES','yellow'],['failedCICount','FAILING CI','red'],['unreadNotifications','NOTIFICATIONS','blue'],['followers','FOLLOWERS','']];
    const byId = id => document.getElementById(id);
    const fmt = value => Number(value || 0).toLocaleString();
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
    const age = value => {
      if (!value) return '';
      const days = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 86400000));
      if (days === 0) return 'today';
      if (days === 1) return '1d ago';
      if (days < 31) return days + 'd ago';
      return Math.round(days / 30) + 'mo ago';
    };

    function renderEmpty(message) {
      byId('activeRepos').innerHTML = '<div class="row meta">' + esc(message) + '</div>';
      byId('languages').innerHTML = '<div class="row meta">' + esc(message) + '</div>';
      byId('ciStatus').innerHTML = '<div class="row meta">' + esc(message) + '</div>';
      byId('notifications').innerHTML = '<div class="row meta">' + esc(message) + '</div>';
      byId('starred').innerHTML = '<div class="row meta">' + esc(message) + '</div>';
    }

    function render(data) {
      byId('account').textContent = '@' + (data.user.login || 'unknown');
      byId('repoCount').textContent = fmt(data.summary.ownRepos || data.summary.totalRepos) + ' repos';
      byId('followers').textContent = fmt(data.summary.followers) + ' followers';
      const tone = { high: 'red', medium: 'yellow', low: 'green', info: 'gray' };
      const errors = data.errors || [];
      byId('pills').innerHTML = (data.priorities.length ? data.priorities : [{ level: errors.length ? 'high' : 'info', title: errors.length ? 'Some Coral sources timed out' : 'No priorities from live data' }])
        .map(p => '<span class="pill ' + (tone[p.level] || 'gray') + '"><span class="dot"></span>' + esc(p.title) + '</span>').join('');
      byId('metrics').innerHTML = metricMap.map(([key,label,toneName]) => '<div class="metric"><div class="num ' + toneName + '">' + fmt(data.summary[key]) + '</div><label>' + label + '</label></div>').join('');
      byId('activeCount').textContent = data.recentRepos.length;
      byId('activeRepos').innerHTML = data.recentRepos.length ? data.recentRepos.map((repo,index) => '<div class="row repo-row"><div><div class="name">' + esc(repo.name) + '</div><div class="meta">' + esc(age(repo.updated_at)) + '</div></div><span class="language-dot" style="background:' + colors[index % colors.length] + '"></span><span class="star">' + (repo.stargazers_count ? '★ ' + fmt(repo.stargazers_count) : '') + '</span></div>').join('') : '<div class="row meta">No repo rows returned.</div>';
      const maxLang = Math.max(...data.languages.map(item => item.repo_count), 1);
      byId('languages').innerHTML = data.languages.length ? data.languages.map((item,index) => '<div class="lang"><span><span class="language-dot" style="display:inline-block;background:' + colors[index % colors.length] + '"></span> ' + esc(item.language || '?') + '</span><div class="bar"><div class="fill" style="width:' + Math.max(8, item.repo_count / maxLang * 100) + '%;background:' + colors[index % colors.length] + '"></div></div><span class="meta">' + fmt(item.repo_count) + ' repos</span></div>').join('') : '<div class="row meta">No language rows returned.</div>';
      byId('ciStatus').innerHTML = data.failedCI.length ? data.failedCI.map(item => '<div class="row repo-row"><span class="danger">×</span><div><div>' + esc((item.repository__full_name || '').split('/').pop()) + '</div><div class="meta">' + esc(item.subject__title || '') + ' · ' + esc(age(item.updated_at)) + '</div></div></div>').join('') : '<div class="row meta">No failing CI notifications returned.</div>';
      byId('notificationCount').textContent = data.summary.unreadNotifications || data.notifications.length;
      byId('notifications').innerHTML = data.notifications.length ? data.notifications.slice(0, 6).map(item => '<div class="row repo-row"><span class="danger">×</span><div><div>' + esc(item.subject__title || item.reason || 'Notification') + '</div><div class="meta">' + esc(item.repository__full_name || '') + '</div></div></div>').join('') : '<div class="row meta">No unread notifications returned.</div>';
      byId('starred').innerHTML = data.starredRepos.length ? data.starredRepos.map(repo => '<div class="row repo-row"><div><div class="name">' + esc(repo.full_name || repo.name) + '</div><div class="meta">' + esc(repo.language || '') + '</div></div><span></span><span class="star">★ ' + fmt(repo.stargazers_count) + '</span></div>').join('') : '<div class="row meta">No starred repos returned.</div>';
      renderTabs(data.queries || defaultQueries);
      byId('result').className = errors.length ? 'error' : '';
      byId('result').textContent = errors.length
        ? JSON.stringify({ live: true, errors, sampleRows: data.queryResult }, null, 2)
        : JSON.stringify(data.queryResult || [], null, 2);
    }

    function renderTabs(queries) {
      const entries = Object.entries(queries);
      byId('queryTabs').innerHTML = entries.map(([key], index) => '<button class="tab ' + (index === 0 ? 'active' : '') + '" data-key="' + esc(key) + '">' + esc(key) + '</button>').join('');
      if (!byId('query').value && entries[0]) byId('query').value = entries[0][1];
      document.querySelectorAll('.tab').forEach(button => {
        button.onclick = () => {
          document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
          button.classList.add('active');
          byId('query').value = queries[button.dataset.key];
        };
      });
    }

    async function loadDashboard() {
      renderTabs(defaultQueries);
      byId('refresh').textContent = '↻ Loading';
      renderEmpty('Loading live Coral SQL...');
      try {
        const response = await fetch('/api/dashboard');
        const data = await response.json();
        render(data);
      } catch (error) {
        byId('result').className = 'error';
        byId('result').textContent = 'Dashboard fetch failed: ' + error.message;
      } finally {
        byId('refresh').textContent = '↻ Refresh';
      }
    }

    byId('refresh').onclick = loadDashboard;
    byId('run').onclick = async () => {
      byId('result').className = '';
      byId('result').textContent = 'Running Coral SQL...';
      try {
        const response = await fetch('/api/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: byId('query').value }),
        });
        const result = await response.json();
        byId('result').className = result.ok === false ? 'error' : '';
        byId('result').textContent = JSON.stringify(result, null, 2);
      } catch (error) {
        byId('result').className = 'error';
        byId('result').textContent = 'Query failed: ' + error.message;
      }
    };

    loadDashboard();
  </script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.type('html').send(renderDashboard());
});

app.get('/api/dashboard', async (req, res) => {
  res.json(await getDashboardData());
});

app.post('/api/query', async (req, res) => {
  res.json(await coralSql(req.body.query || DASHBOARD_QUERIES.repos));
});

app.get('/text', async (req, res) => {
  res.type('text/plain').send(formatBriefing(await getDashboardData()));
});

app.get('/json', async (req, res) => {
  res.json(await getDashboardData());
});

app.get('/health', (req, res) => {
  res.json({ ok: true, coral: CORAL, liveCoral: true, timeoutMs: SQL_TIMEOUT_MS });
});

app.listen(PORT, () => {
  console.log(`Dev First Mate live dashboard running at http://localhost:${PORT}`);
  console.log('All dashboard data and Run Query requests execute through Coral SQL.');
});
