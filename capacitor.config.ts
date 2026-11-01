import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.netcatty.mobile',
  appName: 'Netcatty',
  webDir: 'dist',
  android: { allowMixedContent: true },
};
export default config;
