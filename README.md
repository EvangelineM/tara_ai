Tara — Personal Finance Platform

Full-stack personal finance dashboard with an AI assistant. Tara aggregates portfolio metrics, spending analytics, and investment performance, and answers natural-language questions grounded in real database queries.

## Key Features

- User-friendly dashboard: portfolio value, monthly spend, returns, charts
- Transactions: recent transactions list with search, sort, and filters
- Investments: funds & holdings with gain/loss and return percentages
- Insights: auto-generated observations from your financial data
- Ask Tara: natural-language Q&A routed to SQL-backed tools or the Tara agent

## Demo Screenshots

<table>
	<tr>
		<td align="center"><strong>Overview</strong><br><img src="docs/images/overview.png" width="420" alt="Overview screenshot"></td>
		<td align="center"><strong>Dashboard</strong><br><img src="docs/images/dashboard.png" width="420" alt="Dashboard screenshot"></td>
	</tr>
	<tr>
		<td align="center"><strong>Transactions</strong><br><img src="docs/images/transactions.png" width="420" alt="Transactions screenshot"></td>
		<td align="center"><strong>Ask Tara</strong><br><img src="docs/images/ask.png" width="420" alt="Ask Tara screenshot"></td>
	</tr>
</table>

## Tech Stack

- Backend & agents: Mastra (agents, tools, workflows)
- Language: TypeScript
- Database: PostgreSQL
- AI: Google Gemini (via Mastra model router) for chat and ingestion
- Frontend: Vanilla HTML/CSS/JS, Chart.js

## API Endpoints

- `GET /` — Dashboard UI (static files)
- `GET /dashboard-data` — portfolio metrics, charts, transactions, insights
- `POST /ask` — `{ "question": "..." }` — natural-language Q&A (routes to SQL or agent)

## Quick Start

1. Clone the repository

```bash
git clone https://github.com/your-org/tara-app.git
cd tara-app
```

2. Install dependencies

```bash
npm install
```

3. Create a `.env` in the project root with at least:

```bash
DATABASE_URL=postgresql://user:password@host:5432/tara
GOOGLE_GENERATIVE_AI_API_KEY=your_key_here
```

4. Start the development server (auto-ingests sample data if DB empty)

```bash
npm run dev
```

Open `http://localhost:4111` for the dashboard and Mastra Studio.

## Default Credentials

- No admin account is created by default. The server auto-ingests sample data on first run — create users via the UI or database.

## Environment Variables

- `DATABASE_URL` (required) — PostgreSQL connection string
- `GOOGLE_GENERATIVE_AI_API_KEY` (required for ingestion and agent features)

## Project Structure

- `public/` — frontend static assets and `index.html`
- `data/` — sample JSON datasets (`funds.json`, `holdings.json`, `transactions.json`)
- `scripts/ingest.ts` — ingestion script (JSON → PostgreSQL)
- `src/mastra/` — agents, tools, workflows, scorers
- `src/lib/` — finance queries, ask service, insights builder, normalization
- `src/db/` — database connection

## Demo images to include (paths and purpose)

- `docs/images/overview.png` — REQUIRED: hero screenshot (recommended size 1200×600)
- `docs/images/dashboard.png` — optional: dashboard charts and widgets
- `docs/images/transactions.png` — optional: transactions list and filters
- `docs/images/ask.png` — optional: Ask Tara UI or chat screenshot

Place the hero image at the top of this README using the path `docs/images/overview.png`.

## Scripts

- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run start` — run production server

## License

ISC

---
