# Dragon Con planner: the next site

Dev builds of [dragoncon-planner](https://github.com/KilgoreTrout853/dragoncon-planner), from its `next` branch, at https://kilgoretrout853.github.io/dragoncon-planner-next/. The live site is https://kilgoretrout853.github.io/dragoncon-planner/ and publishes from that repository's `main`; nothing here touches it.

There is no source code in this repository. `.github/workflows/deploy.yml` looks at `next` every ten minutes and on demand; when it has moved it checks the branch out, runs its `build.py` with `DC_CHANNEL=next`, which stamps the page with a **dev build** mark and gives its service worker a cache name of its own, and pushes the result to `gh-pages`. `deployed.txt` records the commit that is live.

To deploy now rather than within ten minutes:

```bash
gh workflow run deploy.yml -R KilgoreTrout853/dragoncon-planner-next
```
