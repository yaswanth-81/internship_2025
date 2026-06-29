/**
 * GitHub Daily Commit Automation
 * Zero-dependency Node.js script using built-in fetch (Node 18+)
 */

const fs = require('fs');
const path = require('path');

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

if (!token || !repo) {
  console.error("Error: GITHUB_TOKEN and GITHUB_REPOSITORY environment variables are required.");
  process.exit(1);
}

const [owner, repoName] = repo.split('/');
const headers = {
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'github-commit-bot',
  'Content-Type': 'application/json'
};

async function githubApi(endpoint, options = {}) {
  const url = `https://api.github.com${endpoint}`;
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  
  if (response.status === 403) {
    const rateRemaining = response.headers.get('X-RateLimit-Remaining');
    if (rateRemaining === '0') {
      throw new Error("403_RATELIMIT: GitHub API rate limit exceeded. Try again in 1 hour.");
    }
  }
  
  if (!response.ok && response.status !== 404) {
    const errorText = await response.text();
    throw new Error(`API Error (${response.status}): ${errorText}`);
  }
  
  return {
    status: response.status,
    data: response.status === 204 ? null : await response.json()
  };
}


async function checkAlreadyCommitted(username) {
  console.log(`Checking if ${username} has already made commits today...\n`);
  const query = {
    query: `
      query {
        user(login: "\\${username}") {
          contributionsCollection {
            contributionCalendar {
              weeks {
                contributionDays {
                  contributionCount
                  date
                }
              }
            }
          }
        }
      }
    `
  };

  try {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer \\${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'github-commit-bot'
      },
      body: JSON.stringify(query)
    });

    if (!response.ok) {
      console.warn("GraphQL check failed, proceeding with commit.");
      return false;
    }

    const res = await response.json();
    if (res.errors) {
      console.warn("GraphQL check returned errors, proceeding with commit:", res.errors[0].message);
      return false;
    }

    const calendar = res.data.user.contributionsCollection.contributionCalendar;
    const todayStr = new Date().toISOString().split('T')[0];
    
    let todayCount = 0;
    calendar.weeks.forEach(week => {
      week.contributionDays.forEach(day => {
        if (day.date === todayStr) {
          todayCount = day.contributionCount;
        }
      });
    });

    if (todayCount > 0) {
      console.log(`User ${username} already has ${todayCount} commit(s) today. Skipping automated commit to keep history clean.\n`);
      return true;
    }
    
    console.log(`No commits found for ${username} today. Proceeding with automated commit.\n`);
    return false;
  } catch (err) {
    console.warn("Error checking commits, proceeding with commit:", err.message);
    return false;
  }
}

async function run() {
  try {
    console.log(`Starting daily commit process for ${repo}...\n`);
    
    // Check if already committed today
    const alreadyCommitted = await checkAlreadyCommitted(owner);
    if (alreadyCommitted) {
      process.exit(0);
    }

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    const timeStr = today.toTimeString().split(' ')[0];
    const timestamp = `${dateStr} ${timeStr}`;

    // Fetch repository owner's profile to attribute the commit correctly (so it counts on their contribution graph)
    console.log(`Fetching profile for ${owner} to attribute commits...\n`);
    let authorName = owner;
    let authorEmail = `${owner}@users.noreply.github.com`;
    try {
      const userProfileRes = await githubApi(`/users/${owner}`);
      if (userProfileRes.status === 200) {
        authorName = userProfileRes.data.name || owner;
        authorEmail = userProfileRes.data.email || `${userProfileRes.data.id}+${owner}@users.noreply.github.com`;
      }
    } catch (profileErr) {
      console.warn("Could not fetch user profile for attribution, using fallback email:", profileErr.message);
    }
    console.log(`Attributing commits to: ${authorName} <${authorEmail}>\n`);

    const journalPath = 'journal.md';
    const logEntry = `\n## ${timestamp}\nDaily log entry - staying consistent.\n`;
    let journalSha = null;
    let journalContent = '';

    console.log(`Checking if ${journalPath} exists...`);
    const journalRes = await githubApi(`/repos/${owner}/${repoName}/contents/${journalPath}`);
    
    if (journalRes.status === 200) {
      journalSha = journalRes.data.sha;
      journalContent = Buffer.from(journalRes.data.content, 'base64').toString('utf8');
    }

    const updatedJournalContent = journalContent + logEntry;
    const journalBody = {
      message: `daily update ${dateStr}`,
      content: Buffer.from(updatedJournalContent).toString('base64'),
      author: {
        name: authorName,
        email: authorEmail
      },
      committer: {
        name: authorName,
        email: authorEmail
      }
    };
    if (journalSha) {
      journalBody.sha = journalSha;
    }

    console.log(`Pushing commit for ${journalPath}...`);
    const commitRes = await githubApi(`/repos/${owner}/${repoName}/contents/${journalPath}`, {
      method: 'PUT',
      body: JSON.stringify(journalBody)
    });
    console.log(`Successfully committed to ${journalPath}!`);

    // Update streak
    const streakPath = 'streak.json';
    let streakSha = null;
    let streakData = { streak: 0, last_commit_date: '', history: [] };

    console.log(`Checking if ${streakPath} exists...`);
    const streakRes = await githubApi(`/repos/${owner}/${repoName}/contents/${streakPath}`);
    
    if (streakRes.status === 200) {
      streakSha = streakRes.data.sha;
      const rawStreak = Buffer.from(streakRes.data.content, 'base64').toString('utf8');
      try { streakData = JSON.parse(rawStreak); } catch (e) {}
    }

    const lastDate = streakData.last_commit_date;
    if (lastDate !== dateStr) {
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      if (lastDate === yesterdayStr) {
        streakData.streak += 1;
      } else {
        streakData.streak = 1;
      }
      streakData.last_commit_date = dateStr;
    }

    streakData.history.push(dateStr);

    const streakBody = {
      message: `update streak.json ${dateStr}`,
      content: Buffer.from(JSON.stringify(streakData, null, 2)).toString('base64'),
      author: {
        name: authorName,
        email: authorEmail
      },
      committer: {
        name: authorName,
        email: authorEmail
      }
    };
    if (streakSha) {
      streakBody.sha = streakSha;
    }

    console.log(`Updating ${streakPath} backup in repository...`);
    await githubApi(`/repos/${owner}/${repoName}/contents/${streakPath}`, {
      method: 'PUT',
      body: JSON.stringify(streakBody)
    });
    console.log("Streak backup updated successfully!");

  } catch (error) {
    console.error("Automation Error:", error.message);
    process.exit(1);
  }
}

run();