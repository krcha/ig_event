# Full-carousel Luna evaluation — 12 October 2026

Full-carousel extraction recovered all **73 manually labeled, unambiguous programs** in this sample, compared with **51** from the live `5bcca9a` cover-only baseline. After the deterministic evidence fixes, **66** had correct date/start/place facts and qualified for automatic approval, compared with **25** correct approvals in the baseline. Seven genuine programs remain pending for missing or invalid evidence. This is a deliberately difficult, small sample; these percentages are not a production-wide accuracy estimate.

Each case had one stochastic provider run per variant, with no repeat sampling; planner replay made no additional provider calls. Both variants used `gpt-6-luna`, the same original captions, posting timestamps, source roles and read-only venue directory. The baseline received one cover per post; the candidate received every retained carousel cover together in one request. Twelve real posts contained **48 slides: 32 images and 16 video thumbnails**. Seven were entirely images, including six positive program cases and one negative control. A fixed prospective evaluation date of `2026-10-01T12:00:00.000Z` allows comparison of the complete October programs without deleting past rows from the evaluation. Production still uses its real current date.

| Real source | Visible programs | Baseline rows / approvals | Candidate rows / approvals |
|---|---:|---:|---:|
| [Dorćol weekly program](https://www.instagram.com/p/DeGftDxCEwE/) | 4 | 0 / 0 | 4 / 4 |
| [Frida monthly program](https://www.instagram.com/p/DeHcAk6jrBM/) | 16 | 4 / 0 | 16 / 16 |
| [KISSA monthly program](https://www.instagram.com/p/DeEy2XvCIy3/) | 15 | 9 / 9 | 15 / 14 |
| [Ložionica weekly program](https://www.instagram.com/p/DeT6CC3ggbo/) | 18 | 18 / 16 | 18 / 17 |
| [Museum of Yugoslavia sessions](https://www.instagram.com/p/Dd9HB7hCojI/) | 3 | 3 / 0 | 3 / 1 |
| [Sprat and Zaokret program](https://www.instagram.com/p/DeJbDN6CMEs/) | 7 | 7 / 4 | 7 / 4 |
| [Ventil film program](https://www.instagram.com/p/DeFYp0_CMRa/) | 8 | 8 / 8 | 8 / 8 |
| [Sila concert](https://www.instagram.com/p/DeHVDuiCOgV/) | 1 | 1 / 1 | 1 / 1 |
| [L’été Double Dose](https://www.instagram.com/p/DeT4opqjS9G/) | 1 | 1 / 1 | 1 / 1 |
| [Museum exhibition recap](https://www.instagram.com/p/DeUdpVDkfzB/) | 0 new events | 0 / 0 | 0 / 0 |
| [REACT festival recap](https://www.instagram.com/p/DeT-0NMiAYt/) | 0 new events | 0 / 0 | 0 / 0 |
| [Club 2099 multi-stage party](https://www.instagram.com/p/DeE9fksDPFs/) | Ambiguous physical venues | 1 / 0 | 1 / 0 |

The approvals column includes every approved row, including incorrect baseline facts. The stricter comparison uses one-to-one matching against independently visible date, clock and physical-venue labels. Titles or billed names distinguish simultaneous programs where needed; title spelling quality is checked separately. A printed time range beginning at the correct start is accepted. The ambiguous Club 2099 post is excluded from the 73-program denominator.

| Check against independent labels | Baseline | Candidate |
|---|---:|---:|
| Genuine program rows recovered | 51 / 73 | 73 / 73 |
| Rows with correct date, start and physical place | 36 / 73 | 73 / 73 |
| Correct automatically approved date/start/place rows | 25 | 66 |
| Incorrect physical venue on approved rows | 3 | 0 |
| Printed start clock missing on approved rows | 11 | 0 |
| Incorrect date or invented explicit start on approved rows | 0 | 0 |
| Exact duplicate occurrence signatures | 0 | 0 |
| New events invented from the two recap controls | 0 | 0 |

All three incorrectly approved baseline venue rows belonged to **Zaokret**, but the source account default changed them to **Sprat**. The candidate preserves Zaokret and holds those rows because Luna omitted the corresponding venue heading from its bound row evidence. All eleven baseline clock omissions were Ložionica sessions whose start times were visible on later slides. Candidate extraction retained those clocks and left genuinely unprinted clocks unknown.

No candidate party was split into one event per DJ or band: the KISSA live pair, Frida band plus supporting DJ, three-band Sila concert and repeated Double Dose flyer each kept their intended single occurrence. Distinct museum sessions, different weekly dates and both AI Boot Camp dates remained separate. These are observed results for these posts, not proof that every future split or merge will be correct. The Club 2099 multi-stage post remains unresolved and pending: Luna supplied no explicit venue-conflict record and retained the account name as a venue; its unusable time evidence blocks publication.

The seven remaining genuine holds are KISSA’s two-letter **OM**, Ložionica’s numeric film title **17**, the three Zaokret programs without bound venue headings, and two museum sessions with paraphrases where the schema required exact caption fragments. Those holds were preserved rather than weakening the safeguards. The six failed behavioral checks are four all-approved expectations for these holds and two Club 2099 venue/conflict expectations. The final candidate passes **148/154 total checks** and **117/123 behavioral checks**; the baseline passes **74/123 behavioral checks**. Protocol checks for full image coverage and source-slide binding are counted separately so they do not inflate the accuracy comparison.

The fresh candidate cohort exposed issues that were corrected before release: bare day numbers under an exact same-slide month header, an empty Umami venue reaching approval, source-account defaults overriding explicitly different row venues, harmless Đ/D typography in a long birthday title, and performer-only titles interrupted by LIVE labels. These changes affect deterministic planning and validation. The provider prompt and structured-output schema stayed frozen; all 24 original provider responses were retained unchanged and then replanned offline with the final code. The candidate provider graph digest was `15122d38f531ff6636b39dfae0d2dbf144288ce1a07675c9791114fec0ee72a9`; the final offline graph digest was `fae63d2255bbeb560ecc71f0af5fac4f296b27d3b287f1e24e99e345e4b29b6e`. The frozen prompt SHA-256 is `0f76666617df6b8c4b010bec2ef7edefeb246ca777e1f64d62f88440f38476bb`.

Full slides cost more per post in this sample:

| Measured provider usage, 12 calls per variant | Baseline | Candidate | Change |
|---|---:|---:|---:|
| Input tokens | 92,608 | 163,470 | +76.5% |
| Output tokens, including reasoning | 28,559 | 40,944 | +43.4% |
| Reasoning tokens, already included above | 10,939 | 18,757 | +71.5% |
| Cached input tokens | 59,356 | 69,234 | Different cache hit mix |
| Median call duration | 20.8 s | 25.2 s | +21.2% |
| Sum of individual call durations | 235.2 s | 324.0 s | +37.8% |

The gain is **43.1% more recovered programs** and more correct automatic approvals, not cheaper individual calls. Combined input/output tokens per correctly approved core program fell from approximately 4,847 to 3,097 in this sample, but that token ratio is not a dollar cost estimate: input, cached input and output have different prices. Reasoning tokens must not be charged a second time. Dollars should be calculated from actual billing and the deployed model’s current prices.

The source investigation found that stored `basicData` manifests lacked the children needed for full carousels. Thirteen bounded `detailedData` source reads produced twelve usable posts and one unavailable post, under a total $0.13 configured ceiling. Immediate run receipts reported zero usage dollars; they are not evidence of a free ongoing scraping pipeline or a settled invoice. Detailed scraping has a separate [post-details charge](https://apify.com/apify/instagram-post-scraper/pricing).

The [machine-readable results](carousel-real-post-evaluation-2026-10-12.json) include the 73 independent core labels, comparison metrics and submitted-index/checksum audit. Reproduction uses `scripts/evaluate-instagram-carousel-posts.mjs` and `scripts/fixtures/instagram-real-carousels-2026-10-12.json` with a protected retained-media manifest and read-only venue snapshot supplied outside Git. The harness checks original and transmitted image checksums, order, source indexes and exact submitted image counts. It journals one request before transport, permits only the OpenAI Responses destination, blocks provider retries, and performs no ingestion or database writes. All 24 authorized calls returned HTTP 200 exactly once.

An initial harness coverage call used the older URL-based helper, which incorrectly treated examined video thumbnails as complete video coverage. Original receipts were archived; offline replay replaced only caller-owned coverage metadata in a clone passed to planning and recorded the original coverage, corrected coverage and immutable provider-response hash. Provider outputs and the saved extracted objects were not edited. Production uses explicit slide-index coverage. All seven image-only cases are complete; the five video or mixed cases remain partial because video interiors were never examined. Private source datasets, signed media URLs, images, credentials and provider payloads are outside Git; the temporary API key was removed after final evaluation.
