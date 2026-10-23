# Options Visualizer glass interface

The main builder at `/` uses the glass interface. The former `/liquid.html` preview
redirects to `/`, preserving the query string and fragment, including shared
strategy URLs. The temporary Material panel, Current design link, and graph
appearance toggle have been removed. Pricing and market-data behavior are unchanged.

## Visual and motion references

1. [Apple — Meet Liquid Glass, WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/).
   Studied lensing, moving highlights, interaction feedback, optical layering,
   regular versus clear materials, and accessibility. The chart stays a readable
   content surface; controls have an optical layer with crisp DOM labels.
2. [Apple — software design announcement and visual gallery](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/).
   Reviewed the clock, floating app navigation, and native controls. Use a thin
   silhouette, neutral lighting, and clear separation from content.
3. [Apple — Materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials).
   Material hierarchy and restraint; avoid treating every nested element as glass.
4. [Apple — Introducing Liquid Glass, video](https://www.youtube.com/watch?v=jGztGfRujSE).
   Additional motion reference for curved shoulders and traveling edge light.
5. [Kube — Liquid Glass in the Browser](https://kube.io/blog/liquid-glass-css-svg/).
   Physics reference for surface normals, Snell refraction, and encoding a vector
   field for SVG displacement. The implementation here is original code using a
   rounded-rectangle distance field, a circular shoulder, and a flat center.
6. [Yassine Bouane — working WebGL demo](https://liquid-glass.ybouane.com/),
   [source](https://github.com/ybouane/liquidglass).
   Compared clear, frosted, dark, and magnifying surfaces over moving video.
   The demo's DOM rasterization costs informed using the browser's native live
   backdrop compositor here instead of recapturing the builder into textures.
7. [Max Rovensky — interactive demo](https://liquid-glass.maxrovensky.com/),
   [source](https://github.com/rdev/liquid-glass-react).
   Compared pointer response, edge bending, configurable frost, and elasticity.
   Used restrained content reflections in this financial workspace.
8. [MDN — backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter).
   Backdrop compositing, clipping, transparency, and filter syntax.
9. [MDN — feDisplacementMap](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap).
   Channel encoding: offset = scale × (channel / 255 − 0.5).

No third-party graphics, packages, or source code are bundled. Reference images
were reviewed on their source pages; the user's Wealthsimple screenshots remain
the reference for the surrounding workspace.

## What is actually rendered

- A rounded-rectangle signed distance field supplies the curved edge normals.
- A single air-to-glass ray bend estimates the displacement. This is a focused
  optical approximation, not a full three-dimensional ray tracer.
- Panels use a neutral surface reflection and a
  geometry-derived curved rim. Colored light is concentrated in that rim instead
  of appearing as a broad diffuse glow behind content. Floating buttons and
  dialogs additionally use native live backdrop frost.
- The chart tooltip refracts an exactly aligned tile of the live SVG chart through
  an encoded normal field. Paths, colors, and clips update with the displayed
  chart; this is actual vector displacement, not an image of a sample chart.
- Local reflections sample the computed colors and screen positions of contract
  icons, strike markers, colored statistics, and the currently clipped P/L curves.
  A call icon therefore reflects green nearby; a put reflects red. Chart reflections
  only reach adjacent glass, with their combined intensity normalized.
- Reflections update when content, layout, or scroll changes, capped at 30 fps.
  Unchanged light fields are cached. There is no inspection lens,
  idle animation loop, or continuous DOM screenshot capture. Refraction maps
  rebuild only on tooltip resizing. Neutral rims and local color intensity are subdued.
- History and Share have a softly damped neutral pointer
  reflection. Large panels do not follow the cursor. Touch does not activate it;
  reduced motion removes damping. Text and focus rings remain crisp.
- A single selected capsule moves between output modes; existing buttons retain
  their original event handlers and accessibility state.
- All four output controls have individual glass faces, curved edge reflections,
  neutral pointer light, and a brighter moving selected capsule. The same controls
  form two rows on narrow screens.
- The graph always uses the glass finish, with curve glow at 70% of
  the original experiment's intensity. It has a
  reflective pane and two soft light layers copied from the live P/L paths.
  The original curves, axes, labels, and hover interactions remain sharp above
  the effect. The main chart geometry is not refracted or distorted.
- Strike markers share the tinted glass finish: call/put colors, a bright upper
  edge, a dark translucent face, and a compact colored halo. Long/short pointers,
  excluded opacity, keyboard focus, overlap lanes, and drag hit areas are retained.

## Scope and compatibility

SVG filter syntax support enables vector chart refraction; native backdrop blur
handles floating controls and dialogs. The current design was visually checked in Chromium.
The previous SVG URL backdrop approach was tested again and rejected: nested
surfaces produced stretched color bands. The stationary panels retain their own
material layer; regular SVG filtering of an explicit live chart source avoids
that backdrop route. This is a browser material approximation,
not Apple's native rendering engine or a full scene ray tracer.
Reduced motion removes output-selection interpolation and pointer-light damping.
Forced-color mode hides optical decorations. Refraction and frost use fixed
defaults (85% and 35% respectively) rather than user-facing experimental controls.

The canvas behind the workspace stays flat. Optical transparency over a flat
background is naturally quiet. The glass picks up subtle, localized content color
without adding a page-wide tint.

## Verification

- 36 JavaScript checks and four Python data-normalization checks pass, including
  five optical geometry/encoding checks.
- Compared thick beveled, thinner clear, and frosted treatments in the browser.
  Kept the thinner finish; rejected broad colored bands and heavy raised borders.
- Chromium preview verified with vector refraction and no JavaScript errors.
- Verified that changing a call to a put changes the corresponding reflected color
  from green to red, and that strike keyboard adjustment keeps the marker and
  reflection aligned. Cursor reflections are limited to small action buttons;
  no inspection lens remains.
- Also tested live date changes, output modes, contract context menu, and position editor.
- Checked 320, 375, 414, and 768 px layouts for overflow; narrow price-axis labels
  are thinned when necessary. The smallest layout stacks model and range controls.
- Checked all four glass output buttons and the permanent glass graph. The glow
  follows each output mode. A stable scrollbar gutter keeps the canvas geometry
  consistent when the page's scrollbar appears or disappears.
- The main entry point contains no temporary appearance controls; the former
  preview URL redirects to it with its query string and fragment intact.

Run the JavaScript checks with `node --test` and the worker normalization checks
with `python tests/yfinance_worker_test.py`. The material layer uses no extra
package dependencies.
