---
title: "Generating website banners algorithmically"
date: 2025-06-07T11:42:21+03:00
draft: false
tags: ["algorithms", "website"]
---

If you've ever visited a DNM, you've probably seen that they heavily utilize dynamically generated images in their anti-phishing and anti-botting systems instead of relying on more traditional CAPTCHAs. I've always been fascinated by the ingenious design of these systems as they don't utilize any JavaScript and are surprisingly often less frustrating to use than the mainstream alternatives like reCAPTCHA, hCAPTCHA, or Arkose Labs.

![Archetyp Market's anti-phishing banner](/images/dynamic-banners/archetyp.png)

My websites don't have any use for this kind of anti-phishing resource, but the way these systems dynamically generate images to make scraping and MitM attacks more difficult brought me the idea to implement a similar system to generate randomized banners for the landing page of my site and put my site's clearweb and hidden service URLs into them, as it'd freshen up the look of the site with copyright-free imagery while providing visual variety.

## Perlin noise algorithm

I didn't know a lot about procedural content generation or its go-to algorithms beforehand, but based on a few searches figured out that Perlin noise could be the way to go for the cohesive and pseudo-random appearance I was looking for. The algorithm is actually quite commonly utilized for procedural terrain generation (2D, 3D, or even 4D), textures, and water/wave simulation in video games precisely because of the smooth/natural appearance it produces.

**TL;DR** Perlin noise works by laying a grid over an image. In this grid, a random gradient vector is placed at each corner where the grid lines meet. For any spot in the image, you then look at the four nearest gradient vectors and calculate dot products to determine how much each of them influences that spot -- either by pushing toward it (positive influence) or away from it (negative influence). Smooth interpolation blends these four corner influences without creating harsh edges, unlike what linear interpolation would produce. Finally, multiple grids of different sizes (called octaves) are typically layered together, with large grids creating broad features and small grids adding fine details.

## Implementation

I wanted to include the following features in the banner generator and then incorporate it into my current HTML + CSS stack:

- Background generation using [`go-perlin`](https://github.com/aquilax/go-perlin/) with a set of custom color gradient themes
- Text overlay with randomly picked positioning and coloring
- Some kind of automated rotation system either from a pool of "active" banners or just a simple scheduled task that'd replace the old banner periodically

### Background generation

Adjusting Perlin's input parameters was a pretty straightforward task through trial and error. The system uses three noise layers: a primary pattern layer scaled to `[0.008, 0.023]` that establishes the overall flow and structure, a medium detail layer scaled to `[0.025, 0.05]` that adds intermediate texture variations, and a fine detail layer scaled to `[0.06, 0.1]` that provides subtle surface complexity. With this configuration, the primary pattern receives 40-80% influence, while medium and fine details contribute 15-40% and 5-20% respectively, ensuring the large-scale structure remains dominant while still providing enough textural variety to filter out most bland, uniform backgrounds without causing too much graining.

```go
for y := range config.BannerHeight {
  for x := range config.BannerWidth {
    baseX := float64(x) + offsetX
    baseY := float64(y) + offsetY

    // optional distortion for more organic patterns
    if useDistortion {
      baseX += math.Sin(float64(y)*0.015) * distortionStrength * 200
      baseY += math.Cos(float64(x)*0.015) * distortionStrength * 200
    }

    // multi-octave noise with randomized scales
    fx1 := baseX * scale1
    fy1 := baseY * scale1
    fx2 := baseX * scale2
    fy2 := baseY * scale2
    fx3 := baseX * scale3
    fy3 := baseY * scale3

    // noise values at different scales
    noise1 := perlinNoise.Noise2D(fx1, fy1)
    noise2 := perlinNoise.Noise2D(fx2, fy2)
    noise3 := perlinNoise.Noise2D(fx3, fy3)

    // ...

    // combined and normalized to [0, 1] range
    noise := min(max((combined+gradientX+gradientY+1)/2, 0), 1)

    pixelColor := palette.interpolate(noise)
    img.Set(x, y, pixelColor)
  }
}
```

The noise is further enhanced through several techniques applied at generation time: optional distortion (applied 40% of the time) that introduces wave-like variations, randomized directional gradients with strengths up to 25% horizontally and 20% vertically, and four different combination methods including standard linear blending, multiplicative effects, maximum value selection for sharp contrasts, and turbulence patterns using absolute values for more chaotic textures. When applied to a 600x120 pixel banner, this configuration guarantees 5-15 visible pattern cycles horizontally, making each background pretty unique.

```go
for y := range config.BannerHeight {
  for x := range config.BannerWidth {
    // ...

    var combined float64
    switch combineMethod {
    case 0: // standard linear combination
      combined = noise1*weight1 + noise2*weight2 + noise3*weight3
    case 1: // multiplicative blend
      combined = (noise1*weight1)*(1+noise2*weight2)*(1+noise3*weight3) - 1
    case 2: // maximum blend (creates sharper patterns)
      values := []float64{noise1 * weight1, noise2 * weight2, noise3 * weight3}
      combined = math.Max(math.Max(values[0], values[1]), values[2])
    case 3: // turbulence (abs. values create more chaotic patterns)
      combined = math.Abs(noise1)*weight1 + math.Abs(noise2)*weight2 + math.Abs(noise3)*weight3
    }

    // randomized gradient with variable direction and strength
    gradientX := (float64(x) / float64(config.BannerWidth)) * gradientStrengthX * gradientDirectionX
    gradientY := (float64(y) / float64(config.BannerHeight)) * gradientStrengthY * gradientDirectionY

    // ...
  }
}
```

### Text overlay setup

The text positioning system employs a two-tiered approach that initially attempts to randomly position each text element within safe boundaries (accounting for text dimensions and outline thickness) without overlapping with previously placed elements, and falls back to placing elements in each of the corners if random placement fails:

1. For each candidate position, generate a random point within the banner's boundaries so that the whole textbox fits within the frame.
2. Perform a simple overlap check against the bounding boxes of all previously placed texts.
3. If no overlap is detected, draw the text there. Otherwise, iterate through steps 1-3 until we've run out of attempts (150 total) or a non-overlapping position is found.
4. If no position can be found within the maximum attempts, calculate how much the bounding box would overlap in each of the banner's four corners and pick the one with the least overlapping area.

Random positioning logic:

```go
x := rand.IntN(maxX-minX+1) + minX
y := rand.IntN(maxY-minY+1) + minY

if isTooCloseToAttempted(x, y) {
  continue
}
attempts = append(attempts, attemptedPos{x: x, y: y})

curRect := struct{ x, y, w, h int }{
  x: x,
  y: y,
  w: w,
  h: h,
}

overlaps := false
for j := 0; j < i; j++ {
	other := textData[j]
	if !other.Positioned {
	  continue
	}

	otherRect := struct{ x, y, w, h int }{
	  x: other.X - padding/2,
	  y: other.Y - padding/2,
	  w: other.W + padding,
	  h: other.H + padding,
	}

	if rectsOverlap(curRect, otherRect) {
	  overlaps = true
	  break
	}
}

if !overlaps {
  data.X = x
  data.Y = y
  data.Positioned = true
  placed = true

  log.Debugf("Placed text '%v' at (%d, %d)", data.Text, x, y)
}
```

Corner fallback mechanism:

```go
corners := []struct {
	name string
	x, y int
}{
	{"top-left", padding, padding},
	{"top-right", config.BannerWidth - w - padding, padding},
	{"bottom-left", padding, config.BannerHeight - h - padding},
	{"bottom-right", config.BannerWidth - w - padding, config.BannerHeight - h - padding},
}

bestCorner := 0
minOverlapArea := int(^uint(0) >> 1) // max. int

for cornerIdx, corner := range corners {
	curRect := struct{ x, y, w, h int }{
		x: corner.x,
		y: corner.y,
		w: w,
		h: h,
	}

	totalOverlapArea := 0

	for j := 0; j < i; j++ {
		other := textData[j]
		if !other.Positioned {
			continue
		}

		otherRect := struct{ x, y, w, h int }{
			x: other.X,
			y: other.Y,
			w: other.W,
			h: other.H,
		}

		if rectsOverlap(curRect, otherRect) {
			overlapLeft := max(curRect.x, otherRect.x)
			overlapTop := max(curRect.y, otherRect.y)
			overlapRight := min(curRect.x+curRect.w, otherRect.x+otherRect.w)
			overlapBottom := min(curRect.y+curRect.h, otherRect.y+otherRect.h)

			overlapWidth := overlapRight - overlapLeft
			overlapHeight := overlapBottom - overlapTop
			overlapArea := overlapWidth * overlapHeight

			totalOverlapArea += overlapArea
		}

		if totalOverlapArea < minOverlapArea {
			minOverlapArea = totalOverlapArea
			bestCorner = cornerIdx
		}

		if totalOverlapArea == 0 {
			break
		}
	}
}

data.X = corners[bestCorner].x
data.Y = corners[bestCorner].y
data.Positioned = true
```

Additionally, placing the larger element (in this case the multiline hidden service URL) first saves a lot of attempts, since the smaller element is more likely to fit into the leftover space than the other way around.

Here are a few examples of the results with this configuration (varying color palettes, noise patterns, and text positioning):

![Varying banner examples](/images/dynamic-banners/banner-variations.png)

### Content serving

The reason why I initially settled on a design that'd keep a separate daemon running and maintain a pool of n different banners replacing the oldest one of them every 12 hours or so was that my whole infra setup was containerized with Docker. It was simple to just spin up a new Alpine container which would have the daemon running and have a common volume with the NGINX container where the randomly picked `b.png` would get served:

```bash
#!/usr/bin/env sh

for site_dir in /banners/*/; do
  if [ -d "$site_dir" ]; then
    rm -f "$site_dir/b.png"
    rb=$(ls $site_dir/*.png | grep -v b.png | shuf -n 1)
    if [ -n "$rb" ]; then
      cp $rb $site_dir/b.png
      chmod 644 $site_dir/b.png
    fi
  fi
done
```

```yaml
mandala-rotator:
  image: alpine:latest
  container_name: mandala-rotator
  command: sh -c "chmod +x /r.sh && /r.sh && echo '*/5 * * * * /r.sh' | crontab - && crond -f"
  volumes:
    - ${PWD}/banners:/banners:rw
    - ${PWD}/rotate.sh:/r.sh:rw
```

```nginx
location /randban {
  root /usr/share/nginx/banners;

  # match 5 min. rotation freq. with caching
  expires 5m;
  add_header Cache-Control "public, max-age=300";

  try_files /b.png =404;
}
```

Afterwards I've migrated my site to Github Pages, which meant that instead of having an always-on daemon running in the background I had to utilize Github Actions to run the binary in "portable mode" once a day:

```yaml
name: Generate website banner

on:
  schedule:
    - cron: "8 0 * * *" # 00:08 daily
  workflow_dispatch:

permissions:
  contents: write

jobs:
  generate-banner:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Download mandala binary
        run: |
          LATEST_RELEASE=$(curl -s "https://api.github.com/repos/200ug/mandala/releases/latest" | jq -r '.tag_name')
          echo "[+] Latest release: $LATEST_RELEASE"

          curl -L -o mandala "https://github.com/200ug/mandala/releases/download/$LATEST_RELEASE/mandala-linux-amd64"
          chmod +x mandala

      - name: Generate banner
        run: |
          ./mandala --single --config ./mandala.json --output ./manout

          if [ -f ./manout/golfed.xyz/banner.png ]; then
            echo "[+] Banner generation successful"
            mv ./manout/golfed.xyz/banner.png ./static/images/banner.png
            rm -rf ./manout
          else
            echo "[!] Banner generation failed"
            exit 1
          fi

      - name: Commit and push banner
        run: |
          git config --local user.email "action@github.com"
          git config --local user.name "GitHub Action"

          git add ./static/images/banner.png

          if git diff --staged --quiet; then
            echo "[!] Git's staging area is empty, nothing to commit"
          else
            git commit -m "banner: $(date '+%Y-%m-%d %H:%M:%S')"
            git push

            echo "[+] Commit pushed"
            
            # trigger the deployment workflow
            curl -X POST \
              -H "Authorization: token ${{ secrets.WORKFLOW_TOKEN }}" \
              -H "Accept: application/vnd.github.v3+json" \
              "https://api.github.com/repos/200ug/golfed.xyz/actions/workflows/deploy.yml/dispatches" \
              -d '{"ref":"master"}'
            
            echo "[+] Workflow triggered via API"
          fi
```

### Performance

In practice there isn't really need to worry about performance if we're going to keep the rotation interval in hours, but here's anyway some benchmarks of the origianl implementation run on Apple M3 with [`hyperfine`](https://github.com/sharkdp/hyperfine):

```shell
$ hyperfine './mandala --portable 500'
Benchmark 1: ./mandala --portable 500
  Time (mean ± σ):     28.485 s ±  0.387 s    [User: 28.145 s, System: 0.242 s]
  Range (min … max):   27.910 s … 29.184 s    10 runs

$ hyperfine './mandala --portable 100'
Benchmark 1: ./mandala --portable 100
  Time (mean ± σ):      5.644 s ±  0.045 s    [User: 5.572 s, System: 0.048 s]
  Range (min … max):    5.547 s …  5.710 s    10 runs

$ hyperfine './mandala --portable 50'
Benchmark 1: ./mandala --portable 50
  Time (mean ± σ):      2.853 s ±  0.066 s    [User: 2.826 s, System: 0.024 s]
  Range (min … max):    2.758 s …  2.956 s    10 runs
```
