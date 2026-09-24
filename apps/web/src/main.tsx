import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import { rfqServerQueryFn } from "./rfq-server-api";
import { WalletProvider } from "./wallet";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found");
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: rfqServerQueryFn,
      refetchOnWindowFocus: (query) => query.queryKey.length !== 1,
      retry: true,
      retryDelay: 5_000,
      staleTime: (query) => (query.queryKey.length === 1 ? Infinity : 0),
    },
  },
});

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <App />
      </WalletProvider>
    </QueryClientProvider>
  </StrictMode>
);
