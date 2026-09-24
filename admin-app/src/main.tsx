import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { AppShell } from "./shell/AppShell";
import { Dashboard } from "./routes/Dashboard";
import { ProjectsList } from "./routes/ProjectsList";
import { PendingTab, ProjectOverviewTab, ProjectWorkspace } from "./routes/ProjectOverview";
import { SystemDesignTab } from "./routes/SystemDesign";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Field use: a stale number is worse than a spinner, but a refetch
      // on every window focus in a truck on LTE is worse than both.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppShell>
          <Routes>
            <Route path="/app" element={<Dashboard />} />
            <Route path="/app/projects" element={<ProjectsList />} />
            <Route path="/app/projects/:id" element={<ProjectWorkspace />}>
              <Route index element={<ProjectOverviewTab />} />
              <Route path="design" element={<SystemDesignTab />} />
              {/* The builder itself is /app/projects/:id/design/build and is
                  NOT a React route — the server serves sitebuilder.html at
                  that path, ahead of the SPA fallback. It is listed here so
                  the next person to read this file knows the URL is taken. */}
              <Route
                path="scope"
                element={
                  <PendingTab
                    title="Scope & proposal"
                    body="Line items, presentation and the proposal document, rebuilt around the quote this job came from."
                  />
                }
              />
              <Route
                path="tasks"
                element={<PendingTab title="Tasks" body="The task list and per-visit completion, rebuilt for the field." />}
              />
              <Route
                path="materials"
                element={<PendingTab title="Materials" body="Material lists and parts for this job." />}
              />
              <Route
                path="records"
                element={<PendingTab title="Daily records" body="Day-by-day hours, notes and photos from each visit." />}
              />
              <Route
                path="changes"
                element={<PendingTab title="Change orders" body="Scope additions, customer approval and the revision they produce." />}
              />
              <Route
                path="financials"
                element={<PendingTab title="Financials" body="Deposit, balance, payments and the invoice handoff." />}
              />
              <Route
                path="closeout"
                element={<PendingTab title="Closeout" body="Completion review, final invoice and the service record." />}
              />
            </Route>
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </AppShell>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
