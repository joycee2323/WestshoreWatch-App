# iOS — Known issues & follow-ups

Tracked technical debt and deferred fixes for the iOS build. Non-blocking unless
noted otherwise.

---

## fmt `FMT_USE_CONSTEVAL` patch is a no-op on the current toolchain (harden before Xcode 26.4)

**Status:** non-urgent. Only needs action **before/when EAS moves the production
build image to Xcode 26.4** (current production image: `macos-sequoia-15.6-xcode-26.2`,
see `eas.json`). Verified against build `1a490842-e60f-4703-b166-42647967af50`.

**Where:** `plugins/withFmtConstevalFix.js` — the config plugin that injects an
`fmt/base.h` patch into the generated `Podfile`'s `post_install` hook.

### What's wrong

1. **The current approach is effectively a no-op on the present toolchain.** The
   plugin prepends this to the top of `fmt/base.h`:

   ```c
   #ifndef FMT_USE_CONSTEVAL
   #define FMT_USE_CONSTEVAL 0
   #endif
   ```

   But `fmt/base.h` later (~line 134) **unconditionally redefines** the macro
   (`#  define FMT_USE_CONSTEVAL 1`), and in the C preprocessor the later
   definition wins. So `FMT_USE_CONSTEVAL` resolves to **1**, not 0, in the code
   that actually uses it. The build log for `1a490842` shows **380
   `-Wmacro-redefined` warnings** (0 errors) confirming fmt overrides our value
   in every translation unit that includes the header.

2. **Therefore it would NOT protect against the Xcode 26.4 / Apple clang 21
   consteval break it is nominally for.** The patch's stated purpose
   (fmtlib/fmt#4740) is to force the macro to `0` so fmt avoids the consteval
   path. Because fmt redefines it back to `1` afterward, that protection does not
   actually take effect. The build currently succeeds only because the production
   image (Xcode 26.2) does not trigger the consteval bug regardless of the macro
   value — i.e. the patch is a benign safety net that isn't doing anything.

   > Note: this is pre-existing behavior — the same `#ifndef`-prepend patch
   > shipped earlier as a hand-edited `Podfile` `post_install` (build 7). The
   > prebuild migration that moved it into `withFmtConstevalFix.js` did not change
   > its effectiveness; it only made it reproducible.

### Recommended fix

Define the macro via the **compiler preprocessor definitions** instead of
prepending to the header, so fmt's own `#define` cannot override it. Set it on
the fmt pod target's build settings in the `Podfile` `post_install` (the plugin
already edits `post_install`), e.g.:

```ruby
installer.pods_project.targets.each do |t|
  next unless t.name == 'fmt'
  t.build_configurations.each do |c|
    c.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
    c.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'FMT_USE_CONSTEVAL=0'
  end
end
```

A command-line `-DFMT_USE_CONSTEVAL=0` takes precedence over an in-source
`#define` only if the source is guarded by `#ifndef` — fmt's redefinition is
**not** guarded, so even `GCC_PREPROCESSOR_DEFINITIONS` may still be overridden.
**Validate on an actual 26.4 image** before relying on it; if the unconditional
redefine still wins, the real fix is to patch fmt's conditional directly (replace
the `#define FMT_USE_CONSTEVAL 1` branch) or pin/patch the fmt pod version. Either
way, confirm zero `-Wmacro-redefined` warnings for `FMT_USE_CONSTEVAL` in the
build log as the success signal.

### When to act

Only when EAS upgrades the production image to Xcode 26.4 (or a clang that
triggers fmtlib/fmt#4740). Until then the build is clean and no action is needed.
