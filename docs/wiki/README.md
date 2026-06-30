# Staged GitHub Wikis

This folder holds wiki content for theDAW and its connected repositories, staged as plain markdown so it can be reviewed before it goes live. Each subfolder maps to one repository's GitHub wiki.

| Folder | Target wiki |
|---|---|
| `theDAW/` | https://github.com/gantasmo/theDAW/wiki |
| `VJ-9000/` | https://github.com/gantasmo/VJ-9000/wiki |
| `magenta-rt2-nvidia/` | https://github.com/gantasmo/magenta-rt2-nvidia/wiki |
| `theDAW-XR/` | https://github.com/gantasmo/theDAW-XR/wiki |

GitHub serves a wiki from a separate git repository at `<repo>.wiki.git`. `Home.md` becomes the landing page and `_Sidebar.md` becomes the navigation rail. The pages here link into each repo's `README.md` and `docs/USER_GUIDE.md` rather than copying them, so the wiki stays current as the canonical docs change.

## Publishing a wiki

The wiki repository exists only after the wiki feature is enabled and the first page is created. Enable it once per repo under Settings, then Features, then Wiki, and create the Home page in the browser. After that:

```bash
# Example for theDAW. Repeat per repo with the matching folder and URL.
git clone https://github.com/gantasmo/theDAW.wiki.git
cp docs/wiki/theDAW/*.md theDAW.wiki/
cd theDAW.wiki
git add -A
git commit -m "Publish wiki: Home, Architecture, Workspaces, Models, Modules, Troubleshooting"
git push
```

Repeat with `VJ-9000/`, `magenta-rt2-nvidia/`, and `theDAW-XR/` against their own `.wiki.git` URLs.

## Note

These files are staged only. Nothing here has been pushed to any wiki. Confirm before publishing, and the push can be run on request.
