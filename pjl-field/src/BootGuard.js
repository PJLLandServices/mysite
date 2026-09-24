// Starts the app, and if starting it throws, SHOWS the error instead of
// closing. See bootError.mjs for why.
//
// Three ways a start can fail, all caught here:
//   1. loading App.js (or anything it imports) throws — App is required
//      lazily inside a try, so a module that throws while loading is
//      caught instead of taking the whole bundle down;
//   2. rendering throws — an error boundary around <App/>;
//   3. a fatal error from anywhere else (an effect, a timer) — a global
//      handler that hands it to this screen instead of the default abort.
//
// It deliberately imports only react-native: if a native module is what
// failed, this screen must not depend on it.

import { Component, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { describeBootError, bootErrorText, installFatalHandler } from './bootError.mjs';

function versionLines() {
  try { return require('./clientVersion').clientVersionText(); } catch { return []; }
}

let fatalListener = null;
let pendingFatal = null;
installFatalHandler(global.ErrorUtils, (error) => {
  pendingFatal = describeBootError(error, { phase: 'running', versionLines: versionLines() });
  if (fatalListener) fatalListener(pendingFatal);
});

let App = null;
let loadError = null;
try {
  App = require('../App').default;
} catch (error) {
  loadError = describeBootError(error, { phase: 'loading the app', versionLines: versionLines() });
}

class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failure: null };
  }
  static getDerivedStateFromError(error) {
    return { failure: describeBootError(error, { phase: 'drawing the screen', versionLines: versionLines() }) };
  }
  render() {
    return this.state.failure ? <BootErrorScreen failure={this.state.failure} /> : this.props.children;
  }
}

export function BootErrorScreen({ failure }) {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>{failure.title}</Text>
        <Text style={styles.advice}>{failure.advice}</Text>
        <Text style={styles.detail} selectable>{bootErrorText(failure)}</Text>
      </ScrollView>
    </View>
  );
}

export default function BootGuard() {
  const [fatal, setFatal] = useState(pendingFatal);
  useEffect(() => {
    fatalListener = setFatal;
    return () => { fatalListener = null; };
  }, []);
  const failure = loadError || fatal;
  if (failure || !App) return <BootErrorScreen failure={failure || describeBootError(new Error('App did not load'), { versionLines: versionLines() })} />;
  return (
    <Boundary>
      <App />
    </Boundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff', paddingTop: 60 },
  body: { padding: 20 },
  title: { fontSize: 20, fontWeight: '700', color: '#1B4D2E', marginBottom: 8 },
  advice: { fontSize: 15, color: '#333333', marginBottom: 16 },
  detail: { fontSize: 12, fontFamily: 'Menlo', color: '#111111' },
});
