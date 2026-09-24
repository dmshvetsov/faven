import { useCallback, useEffect, useRef, useState } from "react";

import {
  createRfqRequest,
  createUnderwriteSubmitRequest,
  isQuoteValid,
  parseTakerMessage,
  quoteMatchesTerms,
  takerWebSocketUrl,
  type ActiveTakerRfqTerms,
  type BestQuote,
  type TakerRfqTerms,
} from "sdk";

const GENERIC_ERROR =
  "Could not get a quote for you. Please refresh the page and try again.";
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export type TakerRfqState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly message?: string }
  | { readonly status: "quote"; readonly quote: BestQuote }
  | { readonly status: "no-buyers" }
  | { readonly status: "error"; readonly message: string };

export type UnderwriteSubmitResult = Readonly<{
  rfqId: string;
  txSignature: string;
}>;

export type TakerRfqController = Readonly<{
  state: TakerRfqState;
  submitUnderwrite(input: {
    readonly rfqId: string;
    readonly underwriteTx: string;
  }): Promise<UnderwriteSubmitResult>;
}>;

type ActiveRequest = {
  readonly requestId: string;
  readonly terms: ActiveTakerRfqTerms;
};

type PendingSubmit = {
  readonly requestId: string;
  readonly rfqId: string;
  readonly reject: (error: Error) => void;
  readonly resolve: (result: UnderwriteSubmitResult) => void;
};

export function useTakerRfq(terms: TakerRfqTerms | null): TakerRfqController {
  const [state, setState] = useState<TakerRfqState>({ status: "idle" });
  const socketRef = useRef<WebSocket | null>(null);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const pendingSubmitRef = useRef<PendingSubmit | null>(null);
  const termsRef = useRef<TakerRfqTerms | null>(terms);
  const requestReadyRef = useRef(false);
  const quoteExpiryTimerRef = useRef<number | null>(null);
  const requestTermsRef = useRef<
    (nextTerms: TakerRfqTerms, loadingMessage?: string) => void
  >(() => {});

  termsRef.current = terms;

  const clearQuoteExpiryTimer = useCallback(() => {
    if (quoteExpiryTimerRef.current !== null) {
      window.clearTimeout(quoteExpiryTimerRef.current);
      quoteExpiryTimerRef.current = null;
    }
  }, []);

  const rejectPendingSubmit = useCallback((message: string) => {
    const pendingSubmit = pendingSubmitRef.current;
    pendingSubmitRef.current = null;
    pendingSubmit?.reject(new Error(message));
  }, []);

  const clearActiveRequest = useCallback(() => {
    clearQuoteExpiryTimer();
    activeRequestRef.current = null;
    rejectPendingSubmit("The quote is no longer available.");
  }, [clearQuoteExpiryTimer, rejectPendingSubmit]);

  const setGenericError = useCallback(
    (retryOnReconnect = false) => {
      clearActiveRequest();
      requestReadyRef.current = retryOnReconnect;
      setState({ status: "error", message: GENERIC_ERROR });
    },
    [clearActiveRequest]
  );

  const expireQuote = useCallback((request: ActiveRequest) => {
    if (activeRequestRef.current?.terms.rfqId !== request.terms.rfqId) return;
    setState({
      status: "loading",
      message: "Quote expired, getting a new one...",
    });
    requestTermsRef.current(
      request.terms,
      "Quote expired, getting a new one..."
    );
  }, []);

  const scheduleQuoteExpiry = useCallback(
    (quote: BestQuote, request: ActiveRequest) => {
      clearQuoteExpiryTimer();
      const delay = Math.max(0, quote.validUntil * 1_000 - Date.now());
      quoteExpiryTimerRef.current = window.setTimeout(
        () => expireQuote(request),
        delay
      );
    },
    [clearQuoteExpiryTimer, expireQuote]
  );

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;

    const requestTerms = (
      nextTerms: TakerRfqTerms,
      loadingMessage?: string
    ) => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;

      try {
        const request = createRfqRequest(nextTerms);
        clearQuoteExpiryTimer();
        activeRequestRef.current = {
          requestId: request.id,
          terms: { ...nextTerms, rfqId: request.params.rfqId },
        };
        setState(
          loadingMessage
            ? { status: "loading", message: loadingMessage }
            : { status: "loading" }
        );
        socket.send(JSON.stringify(request));
      } catch {
        setGenericError();
      }
    };

    requestTermsRef.current = requestTerms;

    const handleMessage = (raw: string) => {
      let message;
      try {
        message = parseTakerMessage(raw);
      } catch {
        setGenericError();
        return;
      }

      if ("error" in message) {
        const pendingSubmit = pendingSubmitRef.current;
        if (pendingSubmit && message.id === pendingSubmit.requestId) {
          pendingSubmitRef.current = null;
          pendingSubmit.reject(new Error("underwrite_submission_failed"));
          return;
        }
        setGenericError();
        return;
      }

      if ("result" in message) {
        const pendingSubmit = pendingSubmitRef.current;
        if (pendingSubmit && message.id === pendingSubmit.requestId) {
          if (
            !("status" in message.result) ||
            message.result.status !== "queued" ||
            message.result.rfqId !== pendingSubmit.rfqId
          ) {
            pendingSubmitRef.current = null;
            pendingSubmit.reject(new Error("invalid_underwrite_submission"));
            return;
          }
          pendingSubmitRef.current = null;
          clearQuoteExpiryTimer();
          activeRequestRef.current = null;
          requestReadyRef.current = false;
          pendingSubmit.resolve({
            rfqId: message.result.rfqId,
            txSignature: message.result.txSignature,
          });
          return;
        }

        if ("status" in message.result) {
          setGenericError();
          return;
        }
        const activeRequest = activeRequestRef.current;
        if (!activeRequest) {
          setGenericError();
          return;
        }
        if (
          message.id !== activeRequest.requestId ||
          message.result.rfqId !== activeRequest.terms.rfqId
        ) {
          setGenericError();
        }
        return;
      }

      const activeRequest = activeRequestRef.current;
      if (!activeRequest) {
        setGenericError();
        return;
      }

      if (message.params.rfqId !== activeRequest.terms.rfqId) {
        setGenericError();
        return;
      }

      if ("noQuoteReason" in message.params) {
        clearActiveRequest();
        requestReadyRef.current = false;
        setState({ status: "no-buyers" });
        return;
      }

      const { quote } = message.params;
      if (!quoteMatchesTerms(quote, activeRequest.terms)) {
        setGenericError();
        return;
      }
      if (!isQuoteValid(quote, Date.now())) {
        expireQuote(activeRequest);
        return;
      }

      setState({ status: "quote", quote });
      scheduleQuoteExpiry(quote, activeRequest);
    };

    const connect = () => {
      if (disposed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(
          takerWebSocketUrl(import.meta.env.VITE_RFQ_SERVER_URL).toString()
        );
      } catch {
        setGenericError();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        reconnectAttempts = 0;
        const currentTerms = termsRef.current;
        if (currentTerms && requestReadyRef.current) requestTerms(currentTerms);
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          setGenericError();
          return;
        }
        handleMessage(event.data);
      };
      socket.onerror = () => {
        const shouldRetry =
          activeRequestRef.current !== null || requestReadyRef.current;
        if (shouldRetry) setGenericError(true);
        socket.close();
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        const shouldRetry =
          activeRequestRef.current !== null || requestReadyRef.current;
        if (shouldRetry) setGenericError(true);
        if (reconnectAttempts >= RECONNECT_DELAYS_MS.length) {
          setGenericError();
          return;
        }
        const delay = RECONNECT_DELAYS_MS[reconnectAttempts];
        reconnectAttempts += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      clearActiveRequest();
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [
    clearActiveRequest,
    clearQuoteExpiryTimer,
    expireQuote,
    scheduleQuoteExpiry,
    setGenericError,
  ]);

  useEffect(() => {
    clearActiveRequest();
    requestReadyRef.current = false;
    if (!terms) {
      setState({ status: "idle" });
      return;
    }

    setState({ status: "loading" });
    const debounceTimer = window.setTimeout(() => {
      requestReadyRef.current = true;
      requestTermsRef.current(terms);
    }, 500);
    return () => window.clearTimeout(debounceTimer);
  }, [clearActiveRequest, terms]);

  const submitUnderwrite = useCallback(
    (input: {
      readonly rfqId: string;
      readonly underwriteTx: string;
    }): Promise<UnderwriteSubmitResult> => {
      const socket = socketRef.current;
      const activeRequest = activeRequestRef.current;
      if (
        !socket ||
        socket.readyState !== WebSocket.OPEN ||
        !activeRequest ||
        activeRequest.terms.rfqId !== input.rfqId ||
        pendingSubmitRef.current
      ) {
        return Promise.reject(new Error("underwrite_submission_unavailable"));
      }

      try {
        const request = createUnderwriteSubmitRequest(input);
        return new Promise<UnderwriteSubmitResult>((resolve, reject) => {
          pendingSubmitRef.current = {
            requestId: request.id,
            rfqId: input.rfqId,
            resolve,
            reject,
          };
          try {
            socket.send(JSON.stringify(request));
          } catch (error) {
            pendingSubmitRef.current = null;
            reject(error);
          }
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    []
  );

  return { state, submitUnderwrite };
}

export { GENERIC_ERROR };
