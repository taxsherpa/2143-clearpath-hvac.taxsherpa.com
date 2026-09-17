# ClearPath Mapper Design Guidelines

## Design Approach

**Selected Approach:** Design System + Financial Dashboard Reference
- **Primary Reference:** Stripe Dashboard, Linear, QuickBooks Online
- **Rationale:** This is a utility-focused financial tool where data clarity, trust, and efficiency are paramount. Drawing from established financial dashboards ensures familiar patterns while maintaining modern aesthetics.

## Core Design Principles

1. **Data Clarity First** - Every number, metric, and category must be instantly readable
2. **Progressive Disclosure** - Complex financial decisions broken into digestible wizard steps
3. **Trust Through Transparency** - Clear labeling, visible calculations, no hidden logic
4. **Scannable Hierarchy** - Financial data organized for quick pattern recognition

---

## Typography

**Font Stack:** Inter (via Google Fonts CDN)
- **Primary Font:** Inter for all text (exceptional readability for numbers and data)

**Type Scale:**
- **Page Titles:** text-3xl font-semibold (30px)
- **Section Headers:** text-xl font-semibold (20px)
- **Card Headers:** text-lg font-medium (18px)
- **Body Text:** text-base (16px)
- **Table Data:** text-sm (14px)
- **Labels/Captions:** text-xs font-medium uppercase tracking-wide (12px, for category badges)
- **Large Numbers (Metrics):** text-4xl font-bold (36px, for dashboard gauges)
- **Small Numbers (Percentages):** text-2xl font-semibold (24px)

**Number Formatting:**
- Monospace variant (font-mono) for currency amounts in tables to ensure alignment
- Regular weight for positive numbers, font-semibold for totals/calculated values

---

## Layout System

**Spacing Primitives:** Tailwind units of 2, 4, 6, 8, 12, 16, 20
- **Component Padding:** p-6 (cards), p-8 (main sections)
- **Element Spacing:** gap-4 (within components), gap-8 (between sections)
- **Section Margins:** mb-8 (between major sections), mb-12 (between workflow stages)

**Container Strategy:**
- **Main Application:** max-w-7xl mx-auto px-6 (centered, comfortable reading width)
- **Wizard Dialogs:** max-w-2xl (focused, decision-making width)
- **Data Tables:** w-full with horizontal scroll on mobile
- **Dashboard Metrics Grid:** grid-cols-1 md:grid-cols-2 lg:grid-cols-4

**Page Structure:**
```
Header (navigation + user) - h-16, sticky top-0
Main Content Area - py-8
  └─ Section spacing - mb-8 between major sections
Footer (if needed) - mt-20
```

---

## Component Library

### Navigation & Header
**Top Navigation Bar:**
- Height: h-16
- Layout: Flex justify-between items-center px-6
- Left: Logo/brand (text-xl font-bold)
- Right: User menu dropdown + action buttons
- Border: border-b with subtle shadow on scroll

### Dashboard Cards
**Metric Cards (Gauges):**
- Structure: Rounded-lg border with shadow-sm
- Padding: p-6
- Layout: Vertical stack with gap-3
- Components:
  - Label (text-xs uppercase tracking-wide)
  - Large number (text-4xl font-bold)
  - Benchmark indicator (text-sm with badge)
  - Visual gauge/progress bar (h-2 rounded-full)

**Status Badges:**
- Sizes: px-3 py-1 rounded-full text-xs font-medium
- Three states with semantic styling:
  - "Healthy" (green badge)
  - "Under" (yellow/amber badge) 
  - "Over" (red badge)

### Data Tables
**Transaction Table:**
- Structure: Full-width with rounded-lg border
- Header Row: bg-gray-50 text-xs font-medium uppercase tracking-wide px-4 py-3
- Data Rows: px-4 py-3 border-t hover:bg-gray-50 (subtle row highlighting)
- Editable Cells: Inline chips/badges for categories with click-to-edit
- Columns: Aligned left for text, right for numbers (text-right font-mono)
- Sticky header on scroll

**Category Chips (Editable):**
- Display: inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm
- States: Default view, hover state (cursor-pointer), editing mode (dropdown)
- Confidence indicators: Small dot or icon showing High/Medium/Needs Review

### Wizard Components
**Split Wizard Dialog:**
- Overlay: Fixed inset with backdrop blur
- Modal: max-w-2xl mx-auto mt-20 rounded-xl shadow-2xl
- Structure:
  - Header: p-6 border-b (Title + close button)
  - Content: p-8 space-y-6
  - Footer: p-6 border-t flex justify-between
  
**Split Input Controls:**
- Dual input mode: Percentage sliders OR dollar inputs
- Real-time preview: Shows split amounts updating as user adjusts
- Visual feedback: Progress bars showing allocation (must total 100%)
- Layout: Grid with 3 columns for Fulfillment/OpEx People/Ascent Moves splits

**Allocation Sliders:**
- Track: h-2 rounded-full
- Thumb: h-5 w-5 rounded-full border-2 shadow
- Labels: Above slider with current percentage (text-sm font-medium)
- Input field: Below slider for precise entry (w-20 text-center)

### Upload Flow
**File Drop Zone:**
- Size: min-h-64 (spacious target area)
- Border: border-2 border-dashed rounded-lg
- States: Default, hover (border solid), dragging (background tinted)
- Content: Centered icon, heading, subtext with file requirements
- Browse button: Inline within drop zone

**Progress Indicators:**
- Parsing: Linear progress bar (h-1 rounded-full) with percentage
- Step indicators: Numbered circles connected by lines (wizard steps)

### Forms & Inputs
**Text Inputs:**
- Height: h-10 px-4
- Border: rounded-lg border focus:ring-2
- Labels: text-sm font-medium mb-2 block

**Buttons:**
**Primary Action:** px-6 py-2.5 rounded-lg font-medium shadow-sm
**Secondary Action:** px-6 py-2.5 rounded-lg border font-medium
**Danger/Delete:** Same structure with semantic red styling
**Icon Buttons:** p-2 rounded-lg (compact for table actions)

### Export & Reports
**PDF Preview/Export:**
- Preview card: aspect-[8.5/11] (US Letter ratio) with border shadow
- Export buttons: Grouped flex gap-4 with download icons

**Variance Alert Cards:**
- Structure: p-6 rounded-lg border-l-4 (accent border indicates severity)
- Layout: Flex items-start gap-4
- Components: Icon, heading, metric comparison, recommendation text

---

## Data Visualization

**Gauge Visualizations:**
- Circular gauges: Not needed - use simpler horizontal progress bars
- Progress bars: h-3 rounded-full with background track
- Benchmark markers: Vertical lines or zones showing target ranges

**Comparison Display:**
- Current vs Benchmark: Side-by-side numbers with delta indicator
- Delta indicators: Arrow icons + percentage difference in parentheses

**Basecamp Scorecard:**
- Each metric displayed as card with:
  - Plain functional label (e.g. "Revenue", "OpEx People") — no metaphor sublabel. The
    retired aviation metaphor ("Altitude", "Fuel", "Engine Temp") must not come back; the
    org's language is Basecamp / Ascent / Summit, and its imagery is mountaineering only.
  - Current percentage
  - Target range
  - Status badge
  - Quick visual gauge

---

## Interaction Patterns

**Table Editing:**
- Click category chip → Dropdown appears inline
- Select new category → Chip updates with animation
- If split needed → Wizard modal launches

**Wizard Navigation:**
- Linear steps: Previous/Next buttons always visible
- Step completion: Check marks on completed steps
- Can't proceed until current step resolved

**Rule Persistence:**
- When saving rule: Brief success toast notification
- Auto-apply indicator: Small badge showing "Rule applied" on future uploads

**Delete Confirmation:**
- Two-step process: Initial button → Confirmation modal
- Explicit warning text about permanent deletion
- Type-to-confirm for destructive actions

---

## Responsive Behavior

**Desktop (lg: 1024px+):**
- 4-column metric grid for dashboard
- Full table width with all columns visible
- Side-by-side wizard content

**Tablet (md: 768px-1023px):**
- 2-column metric grid
- Table with horizontal scroll
- Stacked wizard content

**Mobile (< 768px):**
- Single column metrics
- Simplified table (hide less critical columns)
- Full-width wizard with vertical stacking
- Sticky action buttons at bottom

---

## Visual Hierarchy & Density

**Dashboard Density:** Comfortable - generous whitespace between metric cards (gap-6)
**Table Density:** Compact - maximize visible rows (py-3 row height)
**Wizard Density:** Spacious - clear focus on current decision (py-8 sections)

**Elevation Layers:**
- Base content: No shadow
- Cards: shadow-sm
- Active/hover cards: shadow-md
- Modals: shadow-2xl
- Dropdowns: shadow-lg

---

## Trust & Professional Signals

**Data Integrity Indicators:**
- Confidence badges on auto-mapped items
- Calculation formulas shown (e.g., "Real Revenue = Revenue - Fulfillment")
- Source data always accessible (view original CSV button)

**Professional Polish:**
- Precise number alignment in tables
- Consistent decimal places ($50,000.00 format)
- Clear mathematical operators (−, ×, =) in formulas
- Professional iconography (Heroicons)

---

## Specific Page Layouts

**Upload Page:**
- Centered drop zone (max-w-2xl)
- CSV requirements list below drop zone
- Sample file download link
- Upload history table at bottom (if previous uploads exist)

**Mapping Review Page:**
- Top: Summary cards (Total items, Pre-mapped, Needs review)
- Middle: Full transaction table with category chips
- Bottom: "Continue to wizard" button (fixed on mobile)

**Wizard Pages:**
- Single focused question per screen
- Context explanation at top (2-3 sentences)
- Interactive split controls center
- Preview of impact on right sidebar (desktop) or bottom (mobile)
- Clear navigation: Previous, Skip, Save & Continue

**Dashboard (Results):**
- Top: tier indicator (by annualized Gross Profit) + month indicator
- Main: grid of Basecamp scorecard metrics (Fulfillment, CAC, OpEx Systems, OpEx People,
  Operational Net Profit), then the Ascent figures as plain unscored cards
- Middle: Top 3 Variances section (alert cards)
- Bottom: Export options + Delete data button (subtle, secondary)

---

## Animations

**Use sparingly:**
- Smooth transitions on chip updates (duration-200)
- Progress bar filling (duration-300)
- Modal enter/exit (duration-200 ease-out)
- NO complex scroll effects or decorative animations