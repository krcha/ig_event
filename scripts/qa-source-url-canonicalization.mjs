import assert from "node:assert/strict";

import {
  adaptInstagramScrapedPostToSourceDocument,
  buildSourceDocumentIdentity,
} from "../lib/domain/source-documents.ts";
import {
  canonicalizeSourceUrl,
  getSourceUrlLookupVariants,
  SOURCE_URL_CANONICALIZATION_VERSION,
} from "../lib/domain/source-url.ts";
import { buildSourceOccurrenceIdentity } from "../lib/pipeline/source-occurrence-planning.ts";
import { normalizeInstagramMediaSourceIdentity } from "../lib/images/media-source-identity.ts";

const equivalentInstagramUrls = [
  "https://www.instagram.com/p/Ab_C-91/",
  "https://instagram.com/p/Ab_C-91?utm_source=ig_web_copy_link",
  "https://m.instagram.com/reel/Ab_C-91/?igsh=tracking",
  "http://www.instagram.com/reels/Ab_C-91#media",
  "https://WWW.INSTAGRAM.COM/tv/Ab_C-91/",
];

for (const url of equivalentInstagramUrls) {
  const result = canonicalizeSourceUrl("instagram", url);
  assert.equal(result.ok, true, `${url} should be a canonical Instagram source URL`);
  if (!result.ok) continue;
  assert.deepEqual(
    {
      canonicalUrl: result.value.canonicalUrl,
      externalId: result.value.externalId,
      provider: result.value.provider,
      resourceType: result.value.resourceType,
      version: result.value.version,
    },
    {
      canonicalUrl: "https://www.instagram.com/p/Ab_C-91/",
      externalId: "Ab_C-91",
      provider: "instagram",
      resourceType: "post",
      version: SOURCE_URL_CANONICALIZATION_VERSION,
    },
  );
}

const occurrenceIdentityPost = {
  altText: null,
  caption: null,
  imageUrl: null,
  imageUrls: [],
  instagramPostUrl: equivalentInstagramUrls[0],
  locationName: null,
  postedAt: null,
  postId: "legacy-provider-id",
  postType: null,
  username: "eventzeka",
};
for (const url of equivalentInstagramUrls) {
  assert.equal(
    buildSourceOccurrenceIdentity({ ...occurrenceIdentityPost, instagramPostUrl: url }),
    "instagram-source-identity-v1:Ab_C-91",
    "Occurrence identity must use the shared canonical Instagram external ID.",
  );
}
assert.equal(
  buildSourceOccurrenceIdentity({
    ...occurrenceIdentityPost,
    instagramPostUrl: "legacy-invalid-url",
  }),
  "instagram-source-identity-v1:legacy-provider-id",
  "Invalid legacy URLs must retain the provider-post-ID fallback.",
);

for (const invalidUrl of [
  "",
  "not a url",
  "https://evilinstagram.com/p/Ab_C-91/",
  "https://www.instagram.com/eventzeka/",
  "https://www.instagram.com/p/not!valid/",
  "https://www.instagram.com/p/Ab_C-91/comments/",
  "https://www.instagram.com//p/Ab_C-91/",
  "ftp://www.instagram.com/p/Ab_C-91/",
  "https://user:secret@www.instagram.com/p/Ab_C-91/",
  "https://www.instagram.com:8443/p/Ab_C-91/",
]) {
  const result = canonicalizeSourceUrl("instagram", invalidUrl);
  assert.equal(result.ok, false, `${invalidUrl || "<empty>"} should fail closed`);
  if (result.ok) continue;
  assert.equal(result.error.code, "SOURCE_URL_INVALID");
}

for (const invalidMediaUrl of [
  "https://www.instagram.com/eventzeka/",
  "https://www.instagram.com/p/Ab_C-91/comments/",
  "https://user@www.instagram.com/p/Ab_C-91/",
]) {
  assert.throws(
    () =>
      normalizeInstagramMediaSourceIdentity({
        instagramPostUrl: invalidMediaUrl,
        postId: "Ab_C-91",
      }),
    /canonical Instagram post URL/iu,
    "New media identity writes must reject malformed Instagram source URLs.",
  );
}

assert.deepEqual(
  getSourceUrlLookupVariants(
    "instagram",
    "https://www.instagram.com/reels/Ab_C-91/?utm_source=qa",
  ),
  [
    "https://www.instagram.com/p/Ab_C-91/",
    "https://www.instagram.com/reel/Ab_C-91/",
    "https://www.instagram.com/reels/Ab_C-91/",
    "https://www.instagram.com/tv/Ab_C-91/",
  ],
  "Backfill compatibility lookups should cover every historical Instagram path kind.",
);

const sourceDocument = adaptInstagramScrapedPostToSourceDocument({
  _id: "scraped-post-1",
  _creationTime: 123,
  altText: " Poster text ",
  caption: " Event caption ",
  handle: "@EventZeka",
  imageUrl: "https://example.com/one.jpg",
  imageUrls: ["https://example.com/one.jpg", "https://example.com/two.jpg"],
  instagramPostUrl: "https://www.instagram.com/reel/Ab_C-91/?igsh=qa",
  locationName: " Venue ",
  postId: "provider-post-1",
  sourceKey: "legacy-source-key-must-not-be-authoritative",
  sourceRevision: 7,
});
assert.equal(sourceDocument.canonicalSource.canonicalUrl, "https://www.instagram.com/p/Ab_C-91/");
assert.equal(sourceDocument.providerAccount, "eventzeka");
assert.equal(sourceDocument.sourceRevision, 7);
assert.equal(
  sourceDocument.sourceIdentity,
  buildSourceDocumentIdentity("instagram", sourceDocument.canonicalSource),
);
assert.equal(sourceDocument.sourceIdentity, buildSourceOccurrenceIdentity(occurrenceIdentityPost));
assert.notEqual(
  sourceDocument.sourceIdentity,
  sourceDocument.legacyMetadata?.sourceKey,
  "legacy sourceKey must remain metadata rather than identity authority",
);
assert.deepEqual(sourceDocument.evidence.mediaUrls, [
  "https://example.com/one.jpg",
  "https://example.com/two.jpg",
]);

console.log("Source URL canonicalization QA passed.");
