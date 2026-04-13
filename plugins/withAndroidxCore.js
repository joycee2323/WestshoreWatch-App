const { withProjectBuildGradle } = require('@expo/config-plugins');

// Force androidx.core:core to 1.13.1 so that
// ServiceCompat.startForeground(Service, int, Notification, int)
// is available for react-native-background-actions.
module.exports = function withAndroidxCore(config) {
  return withProjectBuildGradle(config, (config) => {
    const contents = config.modResults.contents;
    if (!contents.includes('androidx.core:core')) {
      config.modResults.contents = contents.replace(
        /allprojects\s*\{/,
        `allprojects {
    configurations.all {
        resolutionStrategy {
            force 'androidx.core:core:1.13.1'
            force 'androidx.core:core-ktx:1.13.1'
        }
    }`,
      );
    }
    return config;
  });
};
