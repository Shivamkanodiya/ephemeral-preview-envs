# 🚀 Automated Ephemeral Preview Environments

> Spin up temporary, isolated preview deployments for every GitHub Pull Request — automatically.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-CI/CD-2088FF?logo=github-actions)
![Render](https://img.shields.io/badge/Render-Deploy-46E3B7?logo=render)

---

## 📋 What Is This?

A **production-style DevOps automation** that creates temporary preview environments for every GitHub Pull Request:

- **PR Opened** → Preview environment is automatically created on Render
- **PR Updated** → Preview rebuilds with new changes
- **PR Merged/Closed** → Preview is automatically destroyed

This gives your team **instant, isolated preview URLs** for code review — just like Vercel, Netlify, and enterprise CI/CD pipelines.

---

## 🏗️ Architecture

```
┌──────────────┐     PR Event      ┌──────────────────┐
│   Developer  │ ──────────────►   │    GitHub Repo    │
│  (PR Created)│                   │                   │
└──────────────┘                   └────────┬──────────┘
                                            │
                                   Triggers Webhook
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │  GitHub Actions   │
                                   │    Workflow        │
                                   └────────┬──────────┘
                                            │
                                   Calls Render API
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │   Render.com      │
                                   │  (Free Tier)      │
                                   │                   │
                                   │ ┌──────────────┐  │
                                   │ │ preview-pr-42│  │
                                   │ │ (isolated)   │  │
                                   │ └──────────────┘  │
                                   └──────────────────┘
                                            │
                                   Preview URL posted
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │  PR Comment       │
                                   │  🔗 preview-url   │
                                   └──────────────────┘
```

---

## 📁 Project Structure

```
ephemeral-preview-envs/
├── .github/
│   └── workflows/
│       ├── preview-env.yml          # Main PR preview workflow
│       └── cleanup-stale.yml        # Daily orphan cleanup cron
├── src/
│   ├── server.js                    # Entry point
│   ├── app.js                       # Express app setup
│   ├── config/
│   │   └── index.js                 # Centralized config + validation
│   ├── controllers/
│   │   └── preview.controller.js    # Business logic orchestrator
│   ├── services/
│   │   ├── render.service.js        # Render API integration
│   │   └── github.service.js        # GitHub API + webhook verification
│   ├── routes/
│   │   ├── health.routes.js         # Health check endpoint
│   │   ├── webhook.routes.js        # GitHub webhook receiver
│   │   └── preview.routes.js        # Preview management API
│   ├── middleware/
│   │   └── webhook.middleware.js     # Signature verification
│   ├── utils/
│   │   └── logger.js                # Winston structured logging
│   └── __tests__/
│       ├── health.test.js
│       ├── render.service.test.js
│       └── github.service.test.js
├── .env.example                     # Environment variable template
├── .gitignore
├── .dockerignore
├── Dockerfile                       # Production container
├── render.yaml                      # Render IaC blueprint
├── package.json
└── README.md
```

---

## 🚀 Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/your-username/ephemeral-preview-envs.git
cd ephemeral-preview-envs
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your Render API key, GitHub token, etc.
```

### 3. Run Locally
```bash
npm run dev
```

### 4. Set GitHub Secrets
In your GitHub repo → Settings → Secrets → Actions:
- `RENDER_API_KEY` — from Render dashboard
- `RENDER_OWNER_ID` — from Render dashboard
- `GITHUB_TOKEN` — auto-provided by GitHub Actions

---

## 🔑 Environment Variables

| Variable | Description | Where to Get |
|----------|-------------|--------------|
| `RENDER_API_KEY` | Render API authentication | [Render Dashboard](https://dashboard.render.com/settings#api-keys) |
| `RENDER_OWNER_ID` | Your Render account/team ID | Render Dashboard → Account |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature verification | GitHub Repo → Settings → Webhooks |
| `GITHUB_TOKEN` | GitHub API access | Auto-provided in Actions / PAT |

---

## 🧪 Testing
```bash
npm test               # Run all tests
npm run test:watch     # Watch mode
```

---

## 📜 License

MIT
