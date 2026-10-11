# Archival newsreel shorts

The dashboard discovers every `.webm` in this directory through `/api/newsreel`.
The reel now contains 16 silent shorts: the original three, ten Cold War / postwar clips,
and three financial-history clips. New excerpts are 10–18 seconds, VP9, 20 fps,
and at most 480 pixels wide. Original footage retains its aspect ratio.

## Sources and attribution

The source pages below record provenance and reuse terms. `credits.json` also records
exact source download URLs, excerpt offsets, and licensing links for the new clips.
All new excerpts were trimmed, resized and re-encoded, with audio removed.
The CC BY 3.0 clips retain their author attribution and license links here and in
`credits.json`; no endorsement by the original creators is implied.

| Short | Attribution | Source | Reuse terms |
| --- | --- | --- | --- |
| Byrnes Sets US Policy for Germany (1946) | US Government newsreel — Public domain | [Source](https://commons.wikimedia.org/wiki/File:1946-09-10_Byrnes_Sets_US_Policy_for_Germany.ogv) | Public domain (see source) |
| Duck and Cover (1951) — Bert the Turtle | US Federal Civil Defense Administration — Public domain | [Source](https://commons.wikimedia.org/wiki/File:Duck_And_Cover_(1951)_Bert_The_Turtle.webm) | Public domain (see source) |
| Tear Down This Wall (1987) | Ronald Reagan, Brandenburg Gate address — US Federal Government work, public domain | [Source](https://commons.wikimedia.org/wiki/File:Tear_down_this_wall.ogv) | Public domain (see source) |
| Vietnam War protests — New York (1967) | Universal Newsreels — Public domain | [Source](https://commons.wikimedia.org/wiki/File:1967-04-18_Peace_March.ogv) | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| Stalin reviews the Victory Parade (1945) — Cold War prelude | USSR / Central Documentary Film Studio — Public domain | [Source](https://commons.wikimedia.org/wiki/File:Victory_Parade_1945.ogv) | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| Berlin Airlift — supplying a blockaded city (1948–49) | British Government — Public domain | [Source](https://commons.wikimedia.org/wiki/File:Berlin_airlift.ogv) | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| Hungarian Revolution — Budapest (1956) | Universal Newsreels — CC0 | [Source](https://commons.wikimedia.org/wiki/File:Hungary_Free.mpg) | [CC0](http://creativecommons.org/publicdomain/zero/1.0/deed.en) |
| Sputnik announcement — newsreel animation (1957) | Universal Newsreels — Public domain | [Source](https://commons.wikimedia.org/wiki/File:1957-10-07_New_Moon.ogv) | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| Yuri Gagarin welcomed in Moscow (1961) | Universal Newsreels — Public domain | [Source](https://commons.wikimedia.org/wiki/File:1961-04-19_First_Pictures-Yuri_Gagarin-selection.ogv) | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| Berlin Wall and border guards (1961) | US Air Force / PublicResourceOrg — CC BY 3.0 | [Source](https://commons.wikimedia.org/wiki/File:Berlin_Documentary.webm) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) |
| Cuban Missile Crisis — naval blockade (1962) | Universal Newsreels — CC0 | [Source](https://commons.wikimedia.org/wiki/File:1962-10-25_The_Cuban_Crisis.ogg) | [CC0](http://creativecommons.org/publicdomain/zero/1.0/deed.en) |
| Space race — Apollo 11 lifts off (1969) | NASA / Kennedy Space Center — Public domain | [Source](https://commons.wikimedia.org/wiki/File:Jack_King%27s_Apollo_11_Launch_Commentary_o4OBKOlgmfo.webm) | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| Nixon visits the Great Wall of China (1972) | Richard Nixon Presidential Library — CC BY 3.0 | [Source](https://commons.wikimedia.org/wiki/File:Nixon_in_China_(The_Film)_-_25_minute_version.webm) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) |
| Great Depression — breadlines (1937) | Works Progress Administration — Public domain | [Source](https://commons.wikimedia.org/wiki/File:We_Work_again_(1937).ogv) | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| New Deal — WPA public works (1937) | Works Progress Administration — Public domain | [Source](https://commons.wikimedia.org/wiki/File:We_Work_again_(1937).ogv) | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| New York Stock Exchange — trading floor (1958) | On Film for the New York Stock Exchange / Prelinger Archives — Public domain | [Source](https://archive.org/details/big_board) | [Public domain](http://creativecommons.org/licenses/publicdomain/) |

## Historical context

- The Stalin excerpt shows the Moscow Victory Parade on 24 June 1945. It is labelled
  a Cold War prelude rather than presented as an event within the conventional Cold War period.
- The Sputnik item is contemporary newsreel **animation**, not footage of the actual launch.
  The source identifies animation reused from an earlier Vanguard report.
- The Depression breadline and New Deal excerpts come from the 1937 WPA film *We Work Again*.
  The captions use the film's year; they do not claim an exact filming date for individual shots.
- *The Big Board* shows the New York Stock Exchange in 1958. The date and producer are
  documented in [the companion Prelinger catalogue record](https://archive.org/details/0730_Big_Board_The_17_01_01_00).
- The Nixon excerpt shows the Great Wall visit during the February 1972 China trip,
  drawn from the Nixon Library's later compilation of archival film.

## Reproduce an excerpt

Download the `sourceDownloadUrl` from its credits entry, then use its `startSeconds`
and `durationSeconds` with FFmpeg:

```sh
ffmpeg -ss START_SECONDS -i SOURCE_FILE -t DURATION_SECONDS -map 0:v:0 -an \
  -vf "scale='min(480,iw)':-2,setsar=1,fps=20" \
  -c:v libvpx-vp9 -crf 36 -b:v 0 -deadline good -cpu-used 4 \
  -threads 2 -pix_fmt yuv420p OUTPUT.webm
```

This recipe applies only to the thirteen clips whose credits entry carries `sourceDownloadUrl`,
`startSeconds` and `durationSeconds`. The three original clips (`byrnes-1946-policy-speech`,
`duck-and-cover-bert-turtle`, `reagan-brandenburg-gate`) are not reproducible from `credits.json`:
their entries have only a free-text `excerpt` range and no download URL or numeric offsets, and the
shipped files are 15 s at 480x360 with their original frame rates (29.97, 29.97 and 25 fps), not the
20 fps recipe above.

Keep the credits entry with any redistributed excerpt. The original full-length downloads
are not bundled in the repository.
