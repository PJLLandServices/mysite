/* The new information architecture. Sections are workspaces, not a flat
   list of 24 database tables — which is what the old sidebar had become.
   Anything not yet rebuilt links back into the existing CRM so nothing
   is lost while the migration runs. */

export interface NavItem {
  label: string;
  to: string;
  /** Set when the destination is still the existing CRM, not the rebuilt app. */
  legacy?: boolean;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    label: "Work",
    items: [
      { label: "Dashboard", to: "/app" },
      { label: "Projects", to: "/app/projects" },
      { label: "Customers", to: "/admin/customers", legacy: true }
    ]
  },
  {
    label: "Operations",
    items: [
      { label: "Calendar", to: "/admin/schedule", legacy: true },
      { label: "Dispatch", to: "/admin/today", legacy: true },
      { label: "Work orders", to: "/admin/work-orders", legacy: true },
      { label: "Season plan", to: "/admin/season-plan", legacy: true }
    ]
  },
  {
    label: "Business",
    items: [
      { label: "Quotes", to: "/admin/quote-folder", legacy: true },
      { label: "Invoices", to: "/admin/invoices", legacy: true },
      { label: "Materials", to: "/admin/material-lists", legacy: true },
      { label: "Settings", to: "/admin/settings", legacy: true }
    ]
  }
];
