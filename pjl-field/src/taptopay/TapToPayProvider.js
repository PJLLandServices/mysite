// Wires the Stripe Terminal SDK to our server, and to nothing else.
//
// The SDK asks for a connection token whenever it needs one — at connect,
// and again when the last one expires. `tokenProvider` is the only hook
// it gives us, and it must resolve to a bare secret string.
//
// Our server hands back TWO things in that one call: the secret and the
// Terminal Location the reader has to be associated with at connect time.
// The provider signature has no room for the second, so the location is
// stashed here and read through context. That is the whole reason this
// file exists rather than passing `tokenProvider` inline.
//
// THE RULE THIS PRESERVES: the app never talks to Stripe. It talks to our
// server, which talks to Stripe with the secret key. No Stripe key of any
// kind is in this bundle — scripts/test-stripe.mjs fails if one appears.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { StripeTerminalProvider } from '@stripe/stripe-terminal-react-native';
import { terminalConnectionToken } from '../api';

const TapToPayContext = createContext({ locationId: null, tokenError: null });

export function useTapToPayLocation() {
  return useContext(TapToPayContext);
}

export function TapToPayProvider({ children }) {
  // A ref for the value the token provider writes (it runs outside
  // React's render cycle), and state for the value screens read.
  const locationRef = useRef(null);
  const [locationId, setLocationId] = useState(null);
  const [tokenError, setTokenError] = useState(null);

  const tokenProvider = useCallback(async () => {
    try {
      const { secret, locationId: loc } = await terminalConnectionToken();
      if (loc && loc !== locationRef.current) {
        locationRef.current = loc;
        setLocationId(loc);
      }
      setTokenError(null);
      return secret;
    } catch (err) {
      // Surfaced rather than swallowed. The two failures that actually
      // happen here are "not signed in" and Stripe's own refusal when
      // Terminal is off, and both are things Patrick can act on — but
      // only if the screen can say which.
      setTokenError(err?.message || 'Could not reach the reader service.');
      // Rethrow: the SDK must see this as a failure, not as an empty
      // token it will try to use.
      throw err;
    }
  }, []);

  const value = useMemo(() => ({ locationId, tokenError }), [locationId, tokenError]);

  return (
    <StripeTerminalProvider tokenProvider={tokenProvider} logLevel="error">
      <TapToPayContext.Provider value={value}>{children}</TapToPayContext.Provider>
    </StripeTerminalProvider>
  );
}
