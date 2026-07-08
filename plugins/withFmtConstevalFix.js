/**
 * Expo config plugin — re-injects the fmt / FMT_USE_CONSTEVAL=0 workaround into
 * the generated Podfile's post_install hook.
 *
 * WHY: now that the iOS project is fully prebuild-managed (ios/ is .easignored),
 * `expo prebuild` regenerates ios/Podfile from the Expo template on every cloud
 * build, wiping any hand-added post_install logic. The fmt patch force-defines
 * FMT_USE_CONSTEVAL=0 at the top of fmt/base.h, before any of its conditional
 * logic runs — required to compile fmt 11.x under recent Xcode / Apple clang,
 * whose consteval strictness otherwise breaks the build (fmtlib/fmt#4740). This
 * plugin restores that patch on every prebuild so the Pods phase keeps compiling.
 *
 * HOW: withDangerousMod('ios') runs after the native directory (and its Podfile)
 * have been generated; we read ios/Podfile, splice the snippet in immediately
 * after `post_install do |installer|`, and write it back. Position within the
 * post_install block is irrelevant to correctness — the snippet patches a file
 * already present in the CocoaPods sandbox, which every target compiles later.
 *
 * IDEMPOTENT: guarded by the WSW_FMT_CONSTEVAL_OVERRIDE sentinel. If the Podfile
 * already contains it (a re-run, or a Podfile that somehow already carries the
 * patch), the plugin is a no-op and cannot double-inject. The snippet itself
 * carries a second, C-comment copy of the same sentinel so the runtime patch of
 * fmt/base.h is likewise applied at most once.
 *
 * KNOWN LIMITATION (non-urgent): on the current Xcode 26.2 image this patch is a
 * no-op — fmt/base.h unconditionally redefines FMT_USE_CONSTEVAL=1 after our
 * top-of-file define (380 -Wmacro-redefined warnings confirm it), so it would
 * NOT actually protect against the Xcode 26.4 consteval break it targets. Harden
 * before EAS moves to a 26.4 image. See docs/ios-known-issues.md.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SENTINEL = 'WSW_FMT_CONSTEVAL_OVERRIDE';

// Ruby injected verbatim into the Podfile's post_install block. Note the
// `#{sentinel}` is Ruby interpolation (left intact — JS only interpolates
// `${...}`), evaluated by CocoaPods at pod-install time.
const FMT_SNIPPET = `
    # ${SENTINEL}
    # Workaround for Xcode 26.4 + Apple clang 21 consteval strictness
    # breaking fmt 11.x. Force-define FMT_USE_CONSTEVAL=0 at the very top of
    # fmt/base.h, before ANY conditional logic runs.
    fmt_base_h = File.join(installer.sandbox.root, 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base_h)
      content = File.read(fmt_base_h)
      sentinel = '// ${SENTINEL}'
      unless content.include?(sentinel)
        prefix = <<~PATCH
          #{sentinel}
          // Force FMT_USE_CONSTEVAL=0 to work around Xcode 26.4 + Apple clang 21
          // consteval strictness breaking fmt 11.x (fmtlib/fmt#4740).
          #ifndef FMT_USE_CONSTEVAL
          #define FMT_USE_CONSTEVAL 0
          #endif

        PATCH
        File.chmod(0644, fmt_base_h)
        File.write(fmt_base_h, prefix + content)
        Pod::UI.puts "  ✓ Force-defined FMT_USE_CONSTEVAL=0 at top of fmt/base.h".green
      else
        Pod::UI.puts "  ✓ fmt/base.h already force-patched".green
      end
    end
`;

const withFmtConstevalFix = (config) =>
  withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let podfile = fs.readFileSync(podfilePath, 'utf8');

      // Idempotency guard — never inject twice.
      if (podfile.includes(SENTINEL)) {
        return cfg;
      }

      const anchor = 'post_install do |installer|';
      const idx = podfile.indexOf(anchor);
      if (idx === -1) {
        throw new Error(
          '[withFmtConstevalFix] Could not find "post_install do |installer|" in the ' +
            'generated Podfile — fmt consteval patch NOT applied. The Podfile template ' +
            'may have changed; update this plugin before building.',
        );
      }

      const insertAt = idx + anchor.length;
      podfile = podfile.slice(0, insertAt) + FMT_SNIPPET + podfile.slice(insertAt);
      fs.writeFileSync(podfilePath, podfile);
      return cfg;
    },
  ]);

module.exports = withFmtConstevalFix;
