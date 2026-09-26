import { registerRootComponent } from 'expo';

// The app starts THROUGH BootGuard: if loading or drawing it throws, the
// phone shows the error instead of closing (src/bootError.mjs has why).
import BootGuard from './src/BootGuard';

// registerRootComponent calls AppRegistry.registerComponent('main', () => BootGuard);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(BootGuard);
