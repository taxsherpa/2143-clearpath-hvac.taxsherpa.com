# ClearPath Mapper

## Overview

ClearPath Mapper is a financial analysis tool that transforms pre-summarized P&L CSV exports (like QuickBooks Online) into actionable insights using the ClearPath framework. The application maps P&L line items to ClearPath categories (Revenue, Fulfillment COGS, Fulfillment Services, CAC, OpEx Systems, OpEx People, Ascent Moves / Tax Strategy) and compares them against tier benchmarks based on annualized Gross Profit.

> **Note:** this file is a leftover of the project's Replit origins and is not the operator's manual. See `README.md` for how to run and deploy this app, and project `2143` in `Tax-Sherpa-OS` for the current scope and decisions.

**Core Value Proposition**: Upload a P&L statement (CSV or PDF), map categories through a hierarchical review interface, and receive a comprehensive financial report with tier-specific benchmark comparisons and variance alerts.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework**: React with TypeScript, built using Vite as the build tool.

**UI Component Library**: shadcn/ui (Radix UI primitives) with Tailwind CSS for styling.
- **Rationale**: Provides accessible, composable components with a design system inspired by financial dashboards (Stripe, Linear, QuickBooks).
- **Design Philosophy**: "Data Clarity First" with progressive disclosure for complex financial decisions.
- **Typography**: Inter font family for exceptional readability of numbers and financial data.

**State Management**: 
- TanStack Query (React Query) for server state
- Local React state for UI interactions
- **Rationale**: Separates server state from UI state, provides automatic caching and refetching.

**Routing**: Wouter (lightweight routing library)
- Main routes: `/auth`, `/upload`, `/review`, `/dashboard`

**Key Frontend Patterns**:
- Protected routes requiring authentication
- File upload with drag-and-drop support
- Multi-step wizard for transaction splitting/categorization
- Real-time form validation using react-hook-form with Zod schemas

### Backend Architecture

**Runtime**: Node.js with Express.js framework

**API Pattern**: RESTful API with JSON responses
- `/api/user` - Authentication endpoints
- `/api/uploads` - CSV upload and processing
- `/api/uploads/:id/nodes` - P&L node hierarchy listing
- `/api/nodes/:id/map` - Category mapping for individual P&L nodes
- `/api/uploads/:id/report` - ClearPath report generation with tier-based benchmarks
- `/api/uploads/:id/export/csv` - CSV export with mapped categories
- `/api/uploads/:id/export/pdf` - PDF summary report

**Authentication**: Passport.js with local strategy
- Session-based authentication using express-session
- PostgreSQL session store (connect-pg-simple)
- Password hashing with scrypt (Node.js crypto module)
- **Rationale**: Local-only accounts for MVP; session-based auth provides simplicity over JWT for server-rendered portions.

**File Processing**:
- Multer for multipart/form-data handling (20MB limit)
- CSV parsing using csv-parse library
- **PDF parsing** using pdf-to-png-converter + OpenAI Vision API (gpt-4o)
  - Converts PDF pages to images
  - Uses AI to extract P&L line items, amounts, and categories
  - Validates and normalizes hierarchy levels
  - Includes retry logic for rate limits
- Automatic pre-mapping using keyword/vendor heuristics
- **Rationale**: In-memory processing is sufficient for single-month files; PDF parsing enables support for any P&L format.

**Business Logic Layers**:
1. **CSV Parser** (`server/lib/csv-parser.ts`): Normalizes column names, validates required fields, infers transaction dates
2. **PDF Parser** (`server/lib/pdf-parser.ts`): Converts PDF pages to images, uses OpenAI vision to extract P&L data, validates hierarchy
3. **Auto-Mapping Engine**: Uses keyword matching and vendor hints to pre-classify transactions
4. **Rules Engine**: Stores and applies user-defined mapping rules for future uploads
5. **Report Generator**: Aggregates transactions into ClearPath categories and calculates benchmark deltas

### Data Storage

**Database**: PostgreSQL via Neon serverless
- **ORM**: Drizzle ORM for type-safe database queries
- **Migration Tool**: drizzle-kit for schema management

**Schema Design**:

**Core Tables**:
- `users` - Email/password authentication
- `uploads` - CSV upload metadata (filename, month, status: parsed/mapped/exported)
- `pl_nodes` - Hierarchical P&L category nodes with parent-child relationships
- `category_mappings` - User category assignments for P&L nodes
- `rules` - User-defined mapping rules (scope: vendor/account/memo, reusable across uploads)

**Key Design Decisions**:
- **Enum-based categories**: `clearpath_category` enum ensures data consistency across the application
- **Hierarchical P&L parsing**: Preserves QuickBooks-style hierarchy (Income > Sales > Product Sales, etc.)
- **Rollup detection**: Distinguishes "Total" rows from leaf nodes to prevent double-counting
- **Only leaf nodes mappable**: Structural headers and rollup totals are display-only

### Tier Benchmarks

The system detects 5 tiers based on annualized **Gross Profit** (monthly * 12). Gross Profit,
not revenue, is the axis: every benchmark below is a percentage of Gross Profit.

| Tier | Annualized GP | Operational Net Profit | CAC | OpEx Systems | OpEx People |
|------|---------------|------------------------|-----|--------------|-------------|
| Under $250K | < $250K | 60-70% | 15% | 10% | 5-15% |
| $250K-$500K | $250K - $500K | 55-60% | 15% | 10% | 15-20% |
| $500K-$1MM | $500K - $1MM | 50% | 15% | 10% | 25% |
| $1MM-$5MM | $1MM - $5MM | 35% | 15% | 10% | 40% |
| $5MM+ | > $5MM | 35% | 15% | 10% | 40% |

Operational Net Profit (the framework's "Owner Net Benefit") is the only one where higher is
better; it is flagged when it falls below the range, never when it exceeds it. Ascent Moves /
Tax Strategy and Taxable Net Profit carry no benchmark at all.

**Fulfillment Benchmarks** (based on gross revenue, auto-detected by business type):
- **Service Business** (fulfillment <= 25%): Target <20%, Warning 20-25%, Danger >25%
- **Goods Business** (fulfillment > 25%): Target <50%, Warning 50-65%, Danger >65%

**Session Storage**: PostgreSQL table managed by connect-pg-simple

### External Dependencies

**Third-Party Services**:
- **Neon Database** (PostgreSQL): Serverless Postgres hosting
  - Connection via `@neondatabase/serverless` with WebSocket support
  - Environment variable: `DATABASE_URL`

**Key NPM Packages**:

**Data Processing**:
- `csv-parse` - CSV file parsing
- `pdf-to-png-converter` - PDF to image conversion
- `openai` - OpenAI API client for vision-based PDF parsing
- `date-fns` - Date manipulation and formatting

**UI Framework**:
- `@radix-ui/*` - Accessible component primitives (24+ components)
- `tailwindcss` - Utility-first CSS framework
- `class-variance-authority` + `clsx` - Dynamic className management

**Backend Core**:
- `express` - Web server framework
- `passport` + `passport-local` - Authentication
- `drizzle-orm` - Type-safe ORM
- `multer` - File upload handling

**Development**:
- `vite` - Build tool and dev server
- `tsx` - TypeScript execution for server
- `esbuild` - Production bundling

**Replit-Specific**:
- `@replit/vite-plugin-runtime-error-modal` - Development error overlay
- `@replit/vite-plugin-cartographer` - Code navigation
- `@replit/vite-plugin-dev-banner` - Development environment indicator

**Design System Resources**:
- Google Fonts CDN (Inter font family)
- No external icon libraries (using lucide-react bundled icons)

**Future Integration Points** (out of scope for Phase 1.0):
- QuickBooks API integration
- Gusto payroll integration
- Multi-entity consolidation
- ML-based auto-categorization