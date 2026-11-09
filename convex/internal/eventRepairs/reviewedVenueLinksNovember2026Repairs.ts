import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { isCrossPostCampaignLineageEvent } from "../../../lib/events/cross-post-campaign-aggregate-attestation";
import {
  hasHumanReviewedStructuredSourceAttestation, hasHumanReviewableStructuredSourceAttestation,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION, nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import { normalizeEventTimeWritePatch } from "../../../lib/events/event-time-write";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { sha256Hex } from "../../../lib/domain/reconciliation/evidence-digest";
import { parseCanonicalEventPayload } from "../../../lib/domain/occurrences/canonical-event-payload";
import { requireAdminOrServiceSecret } from "../../authz";
import { isSupportedExtractionModel } from "../extractionModel";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../sourceOccurrenceReceipts";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import { evaluateEventPublication, isEventPubliclyVisible } from "../../publicationPolicy";
import { savedEventRepository } from "../../repositories/savedEvents";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import { resolveVenueDenormalizedFieldsFromPublicVenues } from "../../eventDomain/moderationVenue";
import {
  prepareInstagramOccurrenceTopologyForDedicatedReattestation, reassignInstagramOccurrenceReferences,
  reassignSavedEventReferences, refreshCanonicalEventDerivedStates, writeEventAuditLog,
} from "../../eventDomain/persistence";
import { assertApprovalCandidatePolicy, assertPersistedServiceSourcePolicy, classifyApprovalCandidates } from "../../eventDomain/sourceApproval";
import { withNovember2026ReadCache } from "./reviewedNovember2026Repairs";

type FrozenSource = { linkId: string; identity: string; key: string; fingerprint: string; documentId: string; postId: string; url: string; handle: string };
type FrozenRow = { id: string; title: string; date: string; time: string; venue: string; venueId: string | null;
  status: "approved" | "pending"; eventType: string; artists: readonly string[]; postId: string; url: string; handle: string;
  key: string; fieldsKey: string; sources: readonly FrozenSource[] };
type FrozenReview = { venueId: string; venueName: string; venueHandle: string; rows: readonly FrozenRow[];
  nextTitle?: string; nextTime?: string; timeDonorId?: string; nextArtists?: readonly string[]; nextDescription?: string;
  distinctControls?: readonly FrozenRow[];
  evidenceSources?: readonly { id: string; postId: string; url: string; handle: string; captionSha256: string }[] };

// Populated only from the frozen source-reviewed incidents below. No caller
// argument can add a row, source, venue, public fact or exclusion to this set.
export const VENUE_LINKS_NOVEMBER_2026_REVIEWS: Readonly<Record<string, FrozenReview>> = {
  "earthworks-kcgrad-nov9": {
    venueId: "k174v2774mz14ercz82srjsxn98963p8",
    venueName: "KC Grad",
    venueHandle: "kcgrad",
    nextDescription: "Exhibition by Ekaterina Shcherbakova in Gradska Galerija at KC Grad, exploring earth as material and questions of territory, origin and belonging.",
    rows: [
      {
        id: "j573khdqxsmy4hb27r6hq8p7e98hj7wx",
        title: "EARTH WORKS",
        date: "2026-11-09",
        time: "20:00",
        venue: "Gradska Galerija",
        venueId: "k178952dxvmp76gqyfa7ps65mh896a43",
        status: "approved",
        eventType: "arts & culture",
        artists: [],
        postId: "4022251194663014117",
        url: "https://www.instagram.com/p/DfR6CaXR47l/",
        handle: "gradska_galerija",
        key: "instagram-occurrence-v2:a843f07fba55887ad6f9921f74ac3c73a1259f1a8903139d820d1b9d71f63669",
        fieldsKey: "instagram-occurrence-v2:a843f07fba55887ad6f9921f74ac3c73a1259f1a8903139d820d1b9d71f63669",
        sources: [
          {
            linkId: "kx71v3j4b1npf04svqnxr5j0kd8hj7qq",
            identity: "instagram-source-identity-v1:DfR6CaXR47l",
            key: "instagram-occurrence-v2:a843f07fba55887ad6f9921f74ac3c73a1259f1a8903139d820d1b9d71f63669",
            fingerprint: "instagram-source-v2:efd316806a01d8328a11d53f056dd303f1aa61b2081db246b13b2e046327b9f1",
            documentId: "jn779mp9965yma4qp8a9nqm0m18hjdr3",
            postId: "4022251194663014117",
            url: "https://www.instagram.com/p/DfR6CaXR47l/",
            handle: "gradska_galerija",
          },
        ],
      },
      {
        id: "j578n3840fzfq3dahnarmg02vn8he82y",
        title: "Earthworks",
        date: "2026-11-09",
        time: "20:00",
        venue: "KC Grad",
        venueId: "k174v2774mz14ercz82srjsxn98963p8",
        status: "approved",
        eventType: "event",
        artists: [],
        postId: "4021503327869219771",
        url: "https://www.instagram.com/p/DfPP_hIsjO7/",
        handle: "kcgrad",
        key: "instagram-occurrence-v2:f77391cd52d50af65ed20e0c2c5e0331c34307b3764cfddc3ad563197fd137c0",
        fieldsKey: "instagram-occurrence-v2:f77391cd52d50af65ed20e0c2c5e0331c34307b3764cfddc3ad563197fd137c0",
        sources: [
          {
            linkId: "kx7244kd8w28t23ejnn8q0wmfs8herva",
            identity: "instagram-source-identity-v1:DfPP_hIsjO7",
            key: "instagram-occurrence-v2:f77391cd52d50af65ed20e0c2c5e0331c34307b3764cfddc3ad563197fd137c0",
            fingerprint: "instagram-source-v2:c763b05c728e93a5f1f4e95088ca3a318484192051033e53f9983289b81de19d",
            documentId: "jn7dmj3p9wqznwqryvjqmqw9an8hfnwv",
            postId: "4021503327869219771",
            url: "https://www.instagram.com/p/DfPP_hIsjO7/",
            handle: "kcgrad",
          },
        ],
      },
    ],
  },
  "dorcoleta-nov7": {
    venueId: "k171f30jjqazr2yvbxbz0wrkps897b6s",
    venueName: "Dor\u0107oleta",
    venueHandle: "dorcoleta_",
    rows: [
      {
        id: "j574ydzb0sawky713cewym83n18hheds",
        title: "Danijel \u010cehranov, Alex Tic, Anya",
        date: "2026-11-07",
        time: "TBD",
        venue: "Dor\u0107oleta",
        venueId: "k171f30jjqazr2yvbxbz0wrkps897b6s",
        status: "approved",
        eventType: "nightlife",
        artists: ["Danijel \u010cehranov", "Alex Tic", "Anya"],
        postId: "4021819262206390895",
        url: "https://www.instagram.com/p/DfQX096orJv/",
        handle: "dorcoleta_",
        key: "instagram-occurrence-v2:49454c077195397a04dc94fc1c675408e746e5c9695e0e132b02bf430d6be5f4",
        fieldsKey: "instagram-occurrence-v2:49454c077195397a04dc94fc1c675408e746e5c9695e0e132b02bf430d6be5f4",
        sources: [
          {
            linkId: "kx7akqb2gxc85kynv3ekvk1kc58hh59x",
            identity: "instagram-source-identity-v1:DfQX096orJv",
            key: "instagram-occurrence-v2:49454c077195397a04dc94fc1c675408e746e5c9695e0e132b02bf430d6be5f4",
            fingerprint: "instagram-source-v2:491a222f396509711053c0dc93e711e8655b609c72ee548329f9d8a5d4aeea6f",
            documentId: "jn77h6reqkspmj48apnfkjbs7s8hhkm0",
            postId: "4021819262206390895",
            url: "https://www.instagram.com/p/DfQX096orJv/",
            handle: "dorcoleta_",
          },
        ],
      },
      {
        id: "j5797gmjd2typcqrnypnzh51gd8hr23z",
        title: "Danijelcehranov, Djalextic, Anyastankovich",
        date: "2026-11-07",
        time: "TBD",
        venue: "Dor\u0107oleta",
        venueId: "k171f30jjqazr2yvbxbz0wrkps897b6s",
        status: "approved",
        eventType: "nightlife",
        artists: ["@danijelcehranov", "@djalextic", "@anyastankovich"],
        postId: "4024392413044182155",
        url: "https://www.instagram.com/p/DfZg5PYRoyL/",
        handle: "zalet.beograd",
        key: "instagram-occurrence-v2:c0c614db617f28a1f555b1f21c7888dd4e8711e5a4593dfd644b359524dd6158",
        fieldsKey: "instagram-occurrence-v2:c0c614db617f28a1f555b1f21c7888dd4e8711e5a4593dfd644b359524dd6158",
        sources: [
          {
            linkId: "kx73jeybbhqqh1e70x5et9rx418hsjpn",
            identity: "instagram-source-identity-v1:DfZg5PYRoyL",
            key: "instagram-occurrence-v2:c0c614db617f28a1f555b1f21c7888dd4e8711e5a4593dfd644b359524dd6158",
            fingerprint: "instagram-source-v2:17309fe4fdefeea872caeb651c6926ac1fd984cd19bc3ca4a55c8f92354a9f32",
            documentId: "jn77ykz7354e8ex38rvng8mzxx8hsbe7",
            postId: "4024392413044182155",
            url: "https://www.instagram.com/p/DfZg5PYRoyL/",
            handle: "zalet.beograd",
          },
        ],
      },
    ],
  },
  "ladi-nov7": {
    "venueId": "k174najg8yc8jksdmrsps5znr58970vq",
    "venueName": "LadiDadi Belgrade",
    "venueHandle": "ladidadi_bar_belgrade",
    "rows": [
      {
        "id": "j571yaaxec9prd561m0mxdgs4h8h40jz",
        "title": "\u0110uskali\u0161te",
        "date": "2026-11-07",
        "time": "22:00",
        "venue": "LadiDadi Belgrade",
        "venueId": "k174najg8yc8jksdmrsps5znr58970vq",
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "@jedan_nenad"
        ],
        "postId": "4022973217677151116",
        "url": "https://www.instagram.com/p/DfUeNOsjouM/",
        "handle": "ladidadi_bar_belgrade",
        "key": "instagram-occurrence-v2:279b3650324e10ca44588f80568f12b8081905f872c32841ca527024ee1ce4b3",
        "fieldsKey": "instagram-occurrence-v2:ab003486c122d464e6b551d9fee1ec181bdfb6378a6a2bbddb61d035bab82bbe",
        "sources": [
          {
            "linkId": "kx75pczmaf84qvhjm4z36nmbwh8h4dy5",
            "identity": "instagram-source-identity-v1:De_umvvOKYj",
            "key": "instagram-occurrence-v2:279b3650324e10ca44588f80568f12b8081905f872c32841ca527024ee1ce4b3",
            "fingerprint": "instagram-source-v2:f1f1d0fa5c17ef4308b3c2db93a2f7eb1f6c04a3b433b0dbb3f5cd697aafe8ba",
            "documentId": "jn76xy8czdpxv2tx78e8d41dws8h4sbp",
            "postId": "4017134365375505955",
            "url": "https://www.instagram.com/p/De_umvvOKYj/",
            "handle": "ladidadi_bar_belgrade"
          },
          {
            "linkId": "kx7ff4cg1t60gabxndxrz0n82h8hnazs",
            "identity": "instagram-source-identity-v1:DfUeNOsjouM",
            "key": "instagram-occurrence-v2:ab003486c122d464e6b551d9fee1ec181bdfb6378a6a2bbddb61d035bab82bbe",
            "fingerprint": "instagram-source-v2:db14a5d66bb26dd488bf714378c0ea35c71fd1569ad627f9c8429856327184c6",
            "documentId": "jn71r7vt8rt16x213dm3g6cnw98hn45r",
            "postId": "4022973217677151116",
            "url": "https://www.instagram.com/p/DfUeNOsjouM/",
            "handle": "ladidadi_bar_belgrade"
          }
        ]
      },
      {
        "id": "j57cr8eh24tfdh6hgcewar55998hf2f9",
        "title": "\u0110u\u0161kali\u0161te",
        "date": "2026-11-07",
        "time": "22:00-04:00",
        "venue": "LadiDadi",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "@jedan_nenad"
        ],
        "postId": "4021508464625467277",
        "url": "https://www.instagram.com/p/DfPRKRHOj-N/",
        "handle": "ladidadi_bar_belgrade",
        "key": "instagram-occurrence-v2:d8a3265592c4ed7f2e2c90b51c46fcf74a3596abe59e6fa61d78384b0ba47f85",
        "fieldsKey": "instagram-occurrence-v2:d8a3265592c4ed7f2e2c90b51c46fcf74a3596abe59e6fa61d78384b0ba47f85",
        "sources": [
          {
            "linkId": "kx73vy2403azfpww2d9z7pams98hera2",
            "identity": "instagram-source-identity-v1:DfPRKRHOj-N",
            "key": "instagram-occurrence-v2:d8a3265592c4ed7f2e2c90b51c46fcf74a3596abe59e6fa61d78384b0ba47f85",
            "fingerprint": "instagram-source-v2:bd1dd8c77392976519a8c551812ba01b998aacf9d58894f6b3361d8f0e072861",
            "documentId": "jn7065xydy4zkkwpmjag7qzav18henhw",
            "postId": "4021508464625467277",
            "url": "https://www.instagram.com/p/DfPRKRHOj-N/",
            "handle": "ladidadi_bar_belgrade"
          }
        ]
      }
    ]
  },
  "vinyl-djir-nov8": {
    "venueId": "k17bp4t9435fgrfxkbpjb7ax3h897rjd",
    "venueName": "Vinyl",
    "venueHandle": "vinyl.belgrade",
    "rows": [
      {
        "id": "j57a510x6ryrtk2nxf1qcy08458hfw3n",
        "title": "\u0110IR PUNI GODINICU",
        "date": "2026-11-08",
        "time": "22:00",
        "venue": "Klub Vinyl",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [],
        "postId": "4020977012846433263",
        "url": "https://www.instagram.com/p/DfNYUoEuRPv/",
        "handle": "djir.bg",
        "key": "instagram-occurrence-v2:a2d2cbc945753bea1ca492df798aa190ac3dbcee5a3591b9ebcfcc6c5e0ae65d",
        "fieldsKey": "instagram-occurrence-v2:a2d2cbc945753bea1ca492df798aa190ac3dbcee5a3591b9ebcfcc6c5e0ae65d",
        "sources": [
          {
            "linkId": "kx703exc09968jh2bm7f24w4md8hexry",
            "identity": "instagram-source-identity-v1:DfNYUoEuRPv",
            "key": "instagram-occurrence-v2:a2d2cbc945753bea1ca492df798aa190ac3dbcee5a3591b9ebcfcc6c5e0ae65d",
            "fingerprint": "instagram-source-v2:80d23c4b35aa996b9820c358f7ebad314914a8c9985a1ae5d14cc0955663964f",
            "documentId": "jn783h5p1qmpqgcn8rn4z3xtdn8hewg0",
            "postId": "4020977012846433263",
            "url": "https://www.instagram.com/p/DfNYUoEuRPv/",
            "handle": "djir.bg"
          }
        ]
      },
      {
        "id": "j5733sxr7ghegnpdszkxd0dqxx8hecza",
        "title": "@knezevic_aleksaa",
        "date": "2026-11-08",
        "time": "22:00",
        "venue": "Vinyl Belgrade Nightclub",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "@knezevic_aleksaa"
        ],
        "postId": "4021615716921490807",
        "url": "https://www.instagram.com/p/DfPpi_mO713/",
        "handle": "djir.bg",
        "key": "instagram-occurrence-v2:8b60bfb040bc99bd13e0aff4065d5721953f1e9d5c29bba0cf3784766341d074",
        "fieldsKey": "instagram-occurrence-v2:8b60bfb040bc99bd13e0aff4065d5721953f1e9d5c29bba0cf3784766341d074",
        "sources": [
          {
            "linkId": "kx768m7hadhf2wee7swnhxp8bx8he2tz",
            "identity": "instagram-source-identity-v1:DfPpi_mO713",
            "key": "instagram-occurrence-v2:8b60bfb040bc99bd13e0aff4065d5721953f1e9d5c29bba0cf3784766341d074",
            "fingerprint": "instagram-source-v2:e36a761f25d616deab7bde6640973198d7ced02e9e464d06d76e889cc374ca01",
            "documentId": "jn749ejqek68m7ewnp2jmd1n658hepfv",
            "postId": "4021615716921490807",
            "url": "https://www.instagram.com/p/DfPpi_mO713/",
            "handle": "djir.bg"
          }
        ]
      }
    ],
    "nextArtists": [
      "@knezevic_aleksaa"
    ],
    "nextDescription": "Proslava prvog ro\u0111endana \u0110IR-a uz @knezevic_aleksaa."
  },
  "karmakoma-cormac-nov13": {
    "venueId": "k179vtk216gam0evmsk0n2c1md897963",
    "venueName": "Karmakoma",
    "venueHandle": "karmakoma_belgrade",
    "rows": [
      {
        "id": "j579smrb26dar5sbebg1waydhx8eya54",
        "title": "@cormacmusic",
        "date": "2026-11-13",
        "time": "TBD",
        "venue": "Karmakoma",
        "venueId": "k179vtk216gam0evmsk0n2c1md897963",
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "@cormacmusic"
        ],
        "postId": "3991788630387603018",
        "url": "https://www.instagram.com/p/DdlrpwksjZK/",
        "handle": "karmakoma_belgrade",
        "key": "instagram-occurrence-v2:5674493f0a60d7c48067afaa1ba02ce0300cde809bcd43d30dbea5ecfa680dbf",
        "fieldsKey": "instagram-occurrence-v2:5674493f0a60d7c48067afaa1ba02ce0300cde809bcd43d30dbea5ecfa680dbf",
        "sources": [
          {
            "linkId": "kx7dyratjfwram9r5pzenf72p98ez1ej",
            "identity": "instagram-source-identity-v1:DdlrpwksjZK",
            "key": "instagram-occurrence-v2:5674493f0a60d7c48067afaa1ba02ce0300cde809bcd43d30dbea5ecfa680dbf",
            "fingerprint": "instagram-source-v2:6018529d8f1277628f9c3177679b7136ec980bd13827db1521fb41899d42f6e5",
            "documentId": "jn790dxmrmpey70bpp3znh546s8eyy2m",
            "postId": "3991788630387603018",
            "url": "https://www.instagram.com/p/DdlrpwksjZK/",
            "handle": "karmakoma_belgrade"
          }
        ]
      },
      {
        "id": "j57e47he28332e74dv7hsvzk9x8gen0n",
        "title": "Cormac",
        "date": "2026-11-13",
        "time": "TBD",
        "venue": "Karmakoma Club",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "Cormac",
          "Felver",
          "Matej Rusmir"
        ],
        "postId": "4009302113628541780",
        "url": "https://www.instagram.com/p/Dej5we4DVNU/",
        "handle": "apgrade",
        "key": "instagram-occurrence-v2:94d134eb111a2628108522298a5ba0d9e041680e080bcb02cf630ed847e70906",
        "fieldsKey": "instagram-occurrence-v2:94d134eb111a2628108522298a5ba0d9e041680e080bcb02cf630ed847e70906",
        "sources": [
          {
            "linkId": "kx76rknww0f9yakgm26eag6j618geh8t",
            "identity": "instagram-source-identity-v1:Dej5we4DVNU",
            "key": "instagram-occurrence-v2:94d134eb111a2628108522298a5ba0d9e041680e080bcb02cf630ed847e70906",
            "fingerprint": "instagram-source-v2:0b1030ac80d52318952084660f51f052905487781095dfea2439aa2d5fded3a9",
            "documentId": "jn7dtr7fc798fzr53q9ghs6sa98geb1k",
            "postId": "4009302113628541780",
            "url": "https://www.instagram.com/p/Dej5we4DVNU/",
            "handle": "apgrade"
          }
        ]
      }
    ],
    "nextTitle": "Cormac",
    "nextArtists": [
      "Cormac",
      "Felver",
      "Matej Rusmir"
    ],
    "nextDescription": "Cormac is joined by Felver and Matej Rusmir."
  },
  "para-climax-nov8": {
    "venueId": "k173mcf2vzdspqqjpmxm0zgm518979ax",
    "venueName": "Para klub",
    "venueHandle": "para_klub",
    "rows": [
      {
        "id": "j5768p8hsjf0s47cm4zgdy22mx8gsgv1",
        "title": "CLIMAX",
        "date": "2026-11-08",
        "time": "06:00-22:00",
        "venue": "Para klub Beograd",
        "venueId": "k173mcf2vzdspqqjpmxm0zgm518979ax",
        "status": "approved",
        "eventType": "nightlife",
        "artists": [],
        "postId": "4013380886539190384",
        "url": "https://www.instagram.com/p/DeyZKcKgsBw/",
        "handle": "para_klub",
        "key": "instagram-occurrence-v2:4ef3fed7a47538f061c4ec18735f1f9f0ea957b428c3c709583a53cc7953489d",
        "fieldsKey": "instagram-occurrence-v2:4ef3fed7a47538f061c4ec18735f1f9f0ea957b428c3c709583a53cc7953489d",
        "sources": [
          {
            "linkId": "kx727891s5p61hjr8sxg95k4as8gsxyn",
            "identity": "instagram-source-identity-v1:DeyZKcKgsBw",
            "key": "instagram-occurrence-v2:4ef3fed7a47538f061c4ec18735f1f9f0ea957b428c3c709583a53cc7953489d",
            "fingerprint": "instagram-source-v2:41bd69dfdadcd63e8862ef0b80cb8fd07dbc807190e756252245869f3623fb47",
            "documentId": "jn7768xj46ccmwg7w7x3hqcbnd8gsah9",
            "postId": "4013380886539190384",
            "url": "https://www.instagram.com/p/DeyZKcKgsBw/",
            "handle": "para_klub"
          }
        ]
      },
      {
        "id": "j57fw01g1f6m67r9e46qnxqxy98h74bz",
        "title": "CLIMAX",
        "date": "2026-11-08",
        "time": "TBD",
        "venue": "Para Klub",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "\u010cevut",
          "Emma H",
          ".Paragon",
          "PT\u017dC",
          "rigid",
          "Tosandra"
        ],
        "postId": "4018098419783810302",
        "url": "https://www.instagram.com/p/DfDJzlXxbz-/",
        "handle": "climax.rs",
        "key": "instagram-occurrence-v2:c9031924e5521fcb3de7b2178147c988f04b11d0733005bda52d3dcf41e0338b",
        "fieldsKey": "instagram-occurrence-v2:c9031924e5521fcb3de7b2178147c988f04b11d0733005bda52d3dcf41e0338b",
        "sources": [
          {
            "linkId": "kx77vq0jj25eehw0380mak04cd8h75z6",
            "identity": "instagram-source-identity-v1:DfDJzlXxbz-",
            "key": "instagram-occurrence-v2:c9031924e5521fcb3de7b2178147c988f04b11d0733005bda52d3dcf41e0338b",
            "fingerprint": "instagram-source-v2:24f32d9a057064f83f42abfe6546834f3e65702e658608dd9040e38b42d89855",
            "documentId": "jn73e1sswd5kzjtg135nxbk0qx8h6h7p",
            "postId": "4018098419783810302",
            "url": "https://www.instagram.com/p/DfDJzlXxbz-/",
            "handle": "climax.rs"
          }
        ]
      }
    ],
    "nextTime": "06:00-22:00",
    "timeDonorId": "j5768p8hsjf0s47cm4zgdy22mx8gsgv1",
    "nextTitle": "CLIMAX",
    "nextArtists": [
      "\u010cevut",
      "Emma H",
      ".Paragon",
      "PT\u017dC",
      "rigid",
      "Tosandra"
    ],
    "nextDescription": "A celebration of freedom with a local lineup."
  },
  "para-preweekender-nov22": {
    "venueId": "k173mcf2vzdspqqjpmxm0zgm518979ax",
    "venueName": "Para klub",
    "venueHandle": "para_klub",
    "rows": [
      {
        "id": "j577r0fs42z9sz08he81298ypn8grn6n",
        "title": "\u041c\u0410\u0413\u041b\u0410",
        "date": "2026-11-22",
        "time": "06:00-22:00",
        "venue": "Para klub Beograd",
        "venueId": "k173mcf2vzdspqqjpmxm0zgm518979ax",
        "status": "approved",
        "eventType": "nightlife",
        "artists": [],
        "postId": "4013380886539190384",
        "url": "https://www.instagram.com/p/DeyZKcKgsBw/",
        "handle": "para_klub",
        "key": "instagram-occurrence-v2:ee4b7799790585b6a3c7dd10f2ab1986f13b516ba8d62efa8b00558cc9012977",
        "fieldsKey": "instagram-occurrence-v2:ee4b7799790585b6a3c7dd10f2ab1986f13b516ba8d62efa8b00558cc9012977",
        "sources": [
          {
            "linkId": "kx75yxrrbge7ecbh8mgp3703858grw3f",
            "identity": "instagram-source-identity-v1:DeyZKcKgsBw",
            "key": "instagram-occurrence-v2:ee4b7799790585b6a3c7dd10f2ab1986f13b516ba8d62efa8b00558cc9012977",
            "fingerprint": "instagram-source-v2:41bd69dfdadcd63e8862ef0b80cb8fd07dbc807190e756252245869f3623fb47",
            "documentId": "jn7768xj46ccmwg7w7x3hqcbnd8gsah9",
            "postId": "4013380886539190384",
            "url": "https://www.instagram.com/p/DeyZKcKgsBw/",
            "handle": "para_klub"
          }
        ]
      },
      {
        "id": "j572cmfaeb9ecefs98ytz8rjmh8h53qp",
        "title": "\u041c\u0410\u0413\u041b\u0410 Pre-Weekender Party",
        "date": "2026-11-22",
        "time": "TBD",
        "venue": "Para Klub",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [],
        "postId": "4017307471172041210",
        "url": "https://www.instagram.com/p/DfAV9xEu3n6/",
        "handle": "magla.events",
        "key": "instagram-occurrence-v2:c325c61651ed9abf8898fdfc054f11b3e6114406b0ec112b5c4c924d271f0b8f",
        "fieldsKey": "instagram-occurrence-v2:c325c61651ed9abf8898fdfc054f11b3e6114406b0ec112b5c4c924d271f0b8f",
        "sources": [
          {
            "linkId": "kx70frjtkrmbpvpz61c43291gn8h4pfa",
            "identity": "instagram-source-identity-v1:DfAV9xEu3n6",
            "key": "instagram-occurrence-v2:c325c61651ed9abf8898fdfc054f11b3e6114406b0ec112b5c4c924d271f0b8f",
            "fingerprint": "instagram-source-v2:9d52bc6e4f29227825eee6d5b1e2bea9ffdbcb80bf7156d8a15e3d96884714aa",
            "documentId": "jn7ahbmwvcjg0kds5yp86jg08d8h4abd",
            "postId": "4017307471172041210",
            "url": "https://www.instagram.com/p/DfAV9xEu3n6/",
            "handle": "magla.events"
          }
        ]
      },
      {
        "id": "j5741jq5fsn0h6msxasd1cft5x8h9745",
        "title": "PRE-WEEKENDER",
        "date": "2026-11-22",
        "time": "TBD",
        "venue": "Para Klub",
        "venueId": null,
        "status": "pending",
        "eventType": "nightlife",
        "artists": [
          "Zadig",
          "XMXMXMXM",
          "A//O",
          "Rope",
          "mdngt",
          "Luka Juki\u0107",
          "Xetem"
        ],
        "postId": "4018772529706026682",
        "url": "https://www.instagram.com/p/DfFjFLKOca6/",
        "handle": "magla.events",
        "key": "instagram-occurrence-v2:b98175e55e3f15e7dda682d56db2cdf13921d28c878f35f118079e1f2a6ffca7",
        "fieldsKey": "instagram-occurrence-v2:b98175e55e3f15e7dda682d56db2cdf13921d28c878f35f118079e1f2a6ffca7",
        "sources": [
          {
            "linkId": "kx7arh6kwwsz0cka4krttym3vd8h8n9s",
            "identity": "instagram-source-identity-v1:DfFjFLKOca6",
            "key": "instagram-occurrence-v2:b98175e55e3f15e7dda682d56db2cdf13921d28c878f35f118079e1f2a6ffca7",
            "fingerprint": "instagram-source-v2:c74942e964cda89e9a820065b7636150a81e9c966f3f46ad9d15e90060616d26",
            "documentId": "jn74nwpanjy0vrhv8w3jn3mdg58h9x0w",
            "postId": "4018772529706026682",
            "url": "https://www.instagram.com/p/DfFjFLKOca6/",
            "handle": "magla.events"
          }
        ]
      }
    ],
    "nextArtists": [
      "Zadig",
      "XMXMXMXM",
      "A//O",
      "Rope",
      "mdngt",
      "Luka Juki\u0107",
      "Xetem"
    ],
    "nextTime": "06:00-22:00",
    "timeDonorId": "j577r0fs42z9sz08he81298ypn8grn6n",
    "nextDescription": "\u041c\u0410\u0413\u041b\u0410 Pre-Weekender Party sa Zadig, XMXMXMXM & A//O live, Rope, mdngt, Luka Juki\u0107 i Xetem.",
    "nextTitle": "\u041c\u0410\u0413\u041b\u0410 Pre-Weekender Party"
  },
  "para-weekender-dec13": {
    "venueId": "k173mcf2vzdspqqjpmxm0zgm518979ax",
    "venueName": "Para klub",
    "venueHandle": "para_klub",
    "rows": [
      {
        "id": "j578cedc7v46jm7xh8zfedq86h8fprhy",
        "title": "WEEKENDER",
        "date": "2026-12-13",
        "time": "TBD",
        "venue": "Para klub Beograd",
        "venueId": "k173mcf2vzdspqqjpmxm0zgm518979ax",
        "status": "approved",
        "eventType": "nightlife",
        "artists": [],
        "postId": "4000608061303477536",
        "url": "https://www.instagram.com/p/DeFA9XrjtUg/",
        "handle": "magla.events",
        "key": "instagram-occurrence-v2:25b514371323b53ebffcb8f88897cd6d160406cb9d1afe1bddf3072d5fb3f1ad",
        "fieldsKey": "instagram-occurrence-v2:25b514371323b53ebffcb8f88897cd6d160406cb9d1afe1bddf3072d5fb3f1ad",
        "sources": [
          {
            "linkId": "kx7bq9kxvjc2wj46tcsxsz35s98fq4r6",
            "identity": "instagram-source-identity-v1:DeFA9XrjtUg",
            "key": "instagram-occurrence-v2:25b514371323b53ebffcb8f88897cd6d160406cb9d1afe1bddf3072d5fb3f1ad",
            "fingerprint": "instagram-source-v2:097e259daa527853f60c0dbd5bc72d01058fbbb9a4df4f4554d0feb452671bfa",
            "documentId": "jn7b1c77d798ngv29y6knjy3zs8fp08c",
            "postId": "4000608061303477536",
            "url": "https://www.instagram.com/p/DeFA9XrjtUg/",
            "handle": "magla.events"
          }
        ]
      },
      {
        "id": "j57by3rzswqv0n615ev8c3qfxn8gmes6",
        "title": "Chloe Lula",
        "date": "2026-12-13",
        "time": "TBD",
        "venue": "Para Klub",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "@chloe.lula"
        ],
        "postId": "4011478652143145178",
        "url": "https://www.instagram.com/p/DeropSVDhDa/",
        "handle": "magla.events",
        "key": "instagram-occurrence-v2:1f3dd6e0573c411d3c0c77bc6bbd4fca32383937d9dd7b3c1b10b9bab086cf49",
        "fieldsKey": "instagram-occurrence-v2:1f3dd6e0573c411d3c0c77bc6bbd4fca32383937d9dd7b3c1b10b9bab086cf49",
        "sources": [
          {
            "linkId": "kx740c5f949k91rj34aczcz9eh8gn76m",
            "identity": "instagram-source-identity-v1:DeropSVDhDa",
            "key": "instagram-occurrence-v2:1f3dd6e0573c411d3c0c77bc6bbd4fca32383937d9dd7b3c1b10b9bab086cf49",
            "fingerprint": "instagram-source-v2:093fd549175480162de745ff2507c4e551949055e91a2809cf7f5fb905503cf2",
            "documentId": "jn74ykpxqz8nzehfv5vg40shh58gn7ze",
            "postId": "4011478652143145178",
            "url": "https://www.instagram.com/p/DeropSVDhDa/",
            "handle": "magla.events"
          }
        ]
      }
    ],
    "nextArtists": [
      "@chloe.lula"
    ],
    "nextDescription": "Zavr\u0161ni dan MAGLA WEEKENDER programa sa Chloe Lula."
  },
  "zappa-galactic-nov13": {
    "venueId": "k1778bpqvg6cmn045s87qfa55x898xvg",
    "venueName": "NOVA ZAPPA BARKA",
    "venueHandle": "zappabarka",
    "rows": [
      {
        "id": "j574hq7kcazgwchayfvvbjb4mh8gahxb",
        "title": "Galactic Explorers - Fiction - Illuzio",
        "date": "2026-11-13",
        "time": "23:00-06:00",
        "venue": "NOVA ZAPPA BARKA",
        "venueId": "k1778bpqvg6cmn045s87qfa55x898xvg",
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "Galactic Explorers",
          "Fiction",
          "Illuzio"
        ],
        "postId": "4007676328435383888",
        "url": "https://www.instagram.com/p/DeeIGMbIf5Q/",
        "handle": "psybeograd",
        "key": "instagram-occurrence-v2:c7bf17406ccacb76d95a03ef88b1d740c343ed92f0ce1178fe041f04b62e904c",
        "fieldsKey": "instagram-occurrence-v2:c7bf17406ccacb76d95a03ef88b1d740c343ed92f0ce1178fe041f04b62e904c",
        "sources": [
          {
            "linkId": "kx7ev12r2xzxfxwb97zn405k1n8ganb4",
            "identity": "instagram-source-identity-v1:DeeIGMbIf5Q",
            "key": "instagram-occurrence-v2:c7bf17406ccacb76d95a03ef88b1d740c343ed92f0ce1178fe041f04b62e904c",
            "fingerprint": "instagram-source-v2:028df5f767ce91488694e4dd88a98df4a2c73aa097f14bd71949da03ab1d5bd9",
            "documentId": "jn7aadbj2wstrcqy4m0y3rz0h58gbzpa",
            "postId": "4007676328435383888",
            "url": "https://www.instagram.com/p/DeeIGMbIf5Q/",
            "handle": "psybeograd"
          }
        ]
      },
      {
        "id": "j57904gpgvq60sdef7xxhak31s8dt4g2",
        "title": "GALACTIC EXPLORERS",
        "date": "2026-11-13",
        "time": "TBD",
        "venue": "Splav Zappa Barka",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "GALACTIC EXPLORERS",
          "PSYCHEDELIC FREQUENCY DJ'S"
        ],
        "postId": "3978864350058380487",
        "url": "https://www.instagram.com/p/Dc3xAuisfzH/",
        "handle": "psybeograd",
        "key": "instagram-occurrence-v2:9fbfc4f03d452a0933c3f976ad9ee5ad87600f1f93ef825668b8de8328165f05",
        "fieldsKey": "instagram-occurrence-v2:9fbfc4f03d452a0933c3f976ad9ee5ad87600f1f93ef825668b8de8328165f05",
        "sources": [
          {
            "linkId": "kx712kp1az30zwp5gvhem5q7d98dvnq4",
            "identity": "instagram-source-identity-v1:Dc3xAuisfzH",
            "key": "instagram-occurrence-v2:9fbfc4f03d452a0933c3f976ad9ee5ad87600f1f93ef825668b8de8328165f05",
            "fingerprint": "instagram-source-v2:deefbdfd77fb8d1e921ea28c6d64d01636120d779728418c861a6ba83a683907",
            "documentId": "jn73ear7hx2g5t5bvre53sed798dt68s",
            "postId": "3978864350058380487",
            "url": "https://www.instagram.com/p/Dc3xAuisfzH/",
            "handle": "psybeograd"
          }
        ]
      }
    ]
  },
  "hangar-haos-dec5": {
    "distinctControls": [
      {
        "id": "j57davczg3efawp0xnw6hmg86d8eyq6j",
        "title": "JURA & FILM",
        "date": "2026-12-05",
        "time": "TBD",
        "venue": "Hangar",
        "venueId": "k179bp5gyxrpchbmf3phqwwe1s896z56",
        "status": "approved",
        "eventType": "live music",
        "artists": [
          "Jura Stubli\u0107 i Film"
        ],
        "postId": "3991732197777777706",
        "url": "https://www.instagram.com/p/Ddle0jnCKQq/",
        "handle": "longplayofficial",
        "key": "instagram-occurrence-v2:7b0d983e033ee8550bab7b82f4f71d583faa53253e35e85874feb260f42f67b5",
        "fieldsKey": "instagram-occurrence-v2:7b0d983e033ee8550bab7b82f4f71d583faa53253e35e85874feb260f42f67b5",
        "sources": [
          {
            "linkId": "kx76734a1gtta7vcex54cccypn8ez8ft",
            "identity": "instagram-source-identity-v1:Ddle0jnCKQq",
            "key": "instagram-occurrence-v2:7b0d983e033ee8550bab7b82f4f71d583faa53253e35e85874feb260f42f67b5",
            "fingerprint": "instagram-source-v2:2b24fc1bc3b1006aebdc26699d5702f4a82d1847ca72d23e1cf32fe005bc8c60",
            "documentId": "jn75x4s12d3mm8fmjy2zmqwpmx8ez7sr",
            "postId": "3991732197777777706",
            "url": "https://www.instagram.com/p/Ddle0jnCKQq/",
            "handle": "longplayofficial"
          }
        ]
      }
    ],
    "venueId": "k179bp5gyxrpchbmf3phqwwe1s896z56",
    "venueName": "Hangar",
    "venueHandle": "hangarbeograd",
    "rows": [
      {
        "id": "j57332j6ggrvdxfmdjs5mh4r6n8gr6nd",
        "title": "PER PLEKS",
        "date": "2026-12-05",
        "time": "22:00-06:00",
        "venue": "Hangar Luka Beograd",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "PER PLEKS"
        ],
        "postId": "4012897275251565540",
        "url": "https://www.instagram.com/p/DewrM-DgKPk/",
        "handle": "nothaos",
        "key": "instagram-occurrence-v2:6a0c7a09b5ca9b873f52487a3e5f8a0ef7c673af037dd9c7debff091221fdd56",
        "fieldsKey": "instagram-occurrence-v2:6a0c7a09b5ca9b873f52487a3e5f8a0ef7c673af037dd9c7debff091221fdd56",
        "sources": [
          {
            "linkId": "kx773989k3218exrev0jv7v3vn8gr3rg",
            "identity": "instagram-source-identity-v1:DewrM-DgKPk",
            "key": "instagram-occurrence-v2:6a0c7a09b5ca9b873f52487a3e5f8a0ef7c673af037dd9c7debff091221fdd56",
            "fingerprint": "instagram-source-v2:0620222d241b48f1255631e4baf5ef11f911bb6ae483c794187c4a5ef7d55ddc",
            "documentId": "jn7fyhv5a9c24bfptjr4yka6298grmhp",
            "postId": "4012897275251565540",
            "url": "https://www.instagram.com/p/DewrM-DgKPk/",
            "handle": "nothaos"
          }
        ]
      },
      {
        "id": "j57fwcyn71zm4nzrbnaxwmfb4s8hb1bw",
        "title": "Fatima Hajji",
        "date": "2026-12-05",
        "time": "22:00-06:00",
        "venue": "Hangar Luka Beograd",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "Fatima Hajji"
        ],
        "postId": "4019500548529139464",
        "url": "https://www.instagram.com/p/DfIInPhkS8I/",
        "handle": "nothaos",
        "key": "instagram-occurrence-v2:484daca09784e341e3032a3638cd7345203aa896d208eb3189d35e55c28c3dfd",
        "fieldsKey": "instagram-occurrence-v2:484daca09784e341e3032a3638cd7345203aa896d208eb3189d35e55c28c3dfd",
        "sources": [
          {
            "linkId": "kx737a45h26q221mctr3bjfars8hae89",
            "identity": "instagram-source-identity-v1:DfIInPhkS8I",
            "key": "instagram-occurrence-v2:484daca09784e341e3032a3638cd7345203aa896d208eb3189d35e55c28c3dfd",
            "fingerprint": "instagram-source-v2:5cf21a063592bd9e3230d3e7946a47f5abc2dd4415585d53aabc2b03218c65a2",
            "documentId": "jn725x06wnzkm89bg05541s00x8hapf9",
            "postId": "4019500548529139464",
            "url": "https://www.instagram.com/p/DfIInPhkS8I/",
            "handle": "nothaos"
          }
        ]
      },
      {
        "id": "j5720ynejp49r46d01p2yxynjn8gd450",
        "title": "SIASIOS",
        "date": "2026-12-05",
        "time": "22:00-06:00",
        "venue": "Hangar",
        "venueId": "k179bp5gyxrpchbmf3phqwwe1s896z56",
        "status": "pending",
        "eventType": "nightlife",
        "artists": [
          "@siasios"
        ],
        "postId": "4008618441773720532",
        "url": "https://www.instagram.com/p/DeheTv2AKPU/",
        "handle": "nothaos",
        "key": "instagram-occurrence-v2:f2e4f5d464b11b610567c006833d8f07eaa314ee6986062c9c62ff678f80a045",
        "fieldsKey": "instagram-occurrence-v2:f2e4f5d464b11b610567c006833d8f07eaa314ee6986062c9c62ff678f80a045",
        "sources": [
          {
            "linkId": "kx77m37zr286z3meq7kz3e59218gd9j4",
            "identity": "instagram-source-identity-v1:DeheTv2AKPU",
            "key": "instagram-occurrence-v2:f2e4f5d464b11b610567c006833d8f07eaa314ee6986062c9c62ff678f80a045",
            "fingerprint": "instagram-source-v2:2b476535af73b01a22daf4969984b38f0d0a4751a1b99527b3b3b6e256dafbcb",
            "documentId": "jn72dmhyh2j831x49n4jaz5sss8gc1me",
            "postId": "4008618441773720532",
            "url": "https://www.instagram.com/p/DeheTv2AKPU/",
            "handle": "nothaos"
          }
        ]
      },
      {
        "id": "j572sn6xdn070a0tvfz61g6z298gapwr",
        "title": "OPTIMUSS",
        "date": "2026-12-05",
        "time": "22:00-06:00",
        "venue": "Hangar",
        "venueId": "k179bp5gyxrpchbmf3phqwwe1s896z56",
        "status": "pending",
        "eventType": "nightlife",
        "artists": [
          "@optimuss.official"
        ],
        "postId": "4007858673475923538",
        "url": "https://www.instagram.com/p/DeexjqegC5S/",
        "handle": "nothaos",
        "key": "instagram-occurrence-v2:d01772b9cc83ab05efb2c8fb7777ae14e917c2084dc5b7f426571523ea692af2",
        "fieldsKey": "instagram-occurrence-v2:d01772b9cc83ab05efb2c8fb7777ae14e917c2084dc5b7f426571523ea692af2",
        "sources": [
          {
            "linkId": "kx7fej0mf1tshg151m74t9x9fx8gbds8",
            "identity": "instagram-source-identity-v1:DeexjqegC5S",
            "key": "instagram-occurrence-v2:d01772b9cc83ab05efb2c8fb7777ae14e917c2084dc5b7f426571523ea692af2",
            "fingerprint": "instagram-source-v2:ce7d27257f8eb3f6143bdcee21f74992cc96eeff9f5f806554abae4f3f67a9a4",
            "documentId": "jn77rnqmg4f533btprn5za286h8gape1",
            "postId": "4007858673475923538",
            "url": "https://www.instagram.com/p/DeexjqegC5S/",
            "handle": "nothaos"
          }
        ]
      },
      {
        "id": "j57dzfx9fm2ncwnj3xp2jedfex8h96mj",
        "title": "Gruber",
        "date": "2026-12-05",
        "time": "22:00-06:00",
        "venue": "Hangar",
        "venueId": "k179bp5gyxrpchbmf3phqwwe1s896z56",
        "status": "pending",
        "eventType": "nightlife",
        "artists": [
          "@gruber.wav"
        ],
        "postId": "4018798219102382566",
        "url": "https://www.instagram.com/p/DfFo7ARkenm/",
        "handle": "nothaos",
        "key": "instagram-occurrence-v2:5eddf189e13d1126013d64d409d3ff6dc0104b06569535f3fa344359277aafc3",
        "fieldsKey": "instagram-occurrence-v2:5eddf189e13d1126013d64d409d3ff6dc0104b06569535f3fa344359277aafc3",
        "sources": [
          {
            "linkId": "kx78fv4r31zmbbar7tq9a3mmwn8h8hgr",
            "identity": "instagram-source-identity-v1:DfFo7ARkenm",
            "key": "instagram-occurrence-v2:5eddf189e13d1126013d64d409d3ff6dc0104b06569535f3fa344359277aafc3",
            "fingerprint": "instagram-source-v2:f653c8b2eda7e6eeb0155b80a6c9cbbdb07d5a5f541ab3d1f09e1a109787a182",
            "documentId": "jn72yh9n1e5mvvtxftd33hes7h8h8gvs",
            "postId": "4018798219102382566",
            "url": "https://www.instagram.com/p/DfFo7ARkenm/",
            "handle": "nothaos"
          }
        ]
      }
    ],
    "nextTitle": "HAOS",
    "nextArtists": [
      "PER PLEKS",
      "Fatima Hajji",
      "@siasios",
      "@optimuss.official",
      "@gruber.wav"
    ],
    "nextDescription": "Fatima Hajji, PER PLEKS, Optimuss, Siasios i Gruber; Gruber otvara ve\u010de dvo\u010dasovnim setom.",
    "evidenceSources": [
      {
        "id": "jn7db7ce057mbwpbnr7xf6h5kx8hf3td",
        "postId": "4021595610590261996",
        "url": "https://www.instagram.com/p/DfPk-aHgLLs/",
        "handle": "nothaos",
        "captionSha256": "b2d6bab8a5f1744ea1467946150c4c9612a247e853e19ff840c0b898558fcdb8"
      }
    ]
  },
  "beton-nye-dec31": {
    "venueId": "k174b5bw553jtfbe0htdkyqvkn896jm3",
    "venueName": "Beton",
    "venueHandle": "betonbelgrade",
    "rows": [
      {
        "id": "j57e65sbe1dthcr073vzgkmywh8h91gy",
        "title": "NYE Rikverc",
        "date": "2026-12-31",
        "time": "22:00",
        "venue": "Klub Beton",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "DJ Mikser",
          "DJ Vlasac"
        ],
        "postId": "4018556815578403089",
        "url": "https://www.instagram.com/p/DfEyCHuRpER/",
        "handle": "rikverc.bg",
        "key": "instagram-occurrence-v2:9e91e4e5eae3c211eec62367d7658aa917d6c785c6114ee7035b5a77d6dea76f",
        "fieldsKey": "instagram-occurrence-v2:9e91e4e5eae3c211eec62367d7658aa917d6c785c6114ee7035b5a77d6dea76f",
        "sources": [
          {
            "linkId": "kx74xhs90vkhfehvqvm40q7px58h9akp",
            "identity": "instagram-source-identity-v1:DfEyCHuRpER",
            "key": "instagram-occurrence-v2:9e91e4e5eae3c211eec62367d7658aa917d6c785c6114ee7035b5a77d6dea76f",
            "fingerprint": "instagram-source-v2:a1dc5e7b6786e090ab3ea774c7302b2e4ce5f38adf8ed19cd33228730992b967",
            "documentId": "jn70jdwymchrrhvpc5xnk2hpb18h90nk",
            "postId": "4018556815578403089",
            "url": "https://www.instagram.com/p/DfEyCHuRpER/",
            "handle": "rikverc.bg"
          }
        ]
      },
      {
        "id": "j57b902a03y2gcfbgk3vrx4v6d8h8jys",
        "title": "NYE Rikverc",
        "date": "2026-12-31",
        "time": "22:00",
        "venue": "Club Beton",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "DJ Mikser",
          "DJ Vlasac"
        ],
        "postId": "4018557182546349473",
        "url": "https://www.instagram.com/p/DfEyHdfRQ2h/",
        "handle": "rikverc.bg",
        "key": "instagram-occurrence-v2:85bdcd92daf31ddc1eacddc56331626813c09247774a3a72f345120762f769ca",
        "fieldsKey": "instagram-occurrence-v2:85bdcd92daf31ddc1eacddc56331626813c09247774a3a72f345120762f769ca",
        "sources": [
          {
            "linkId": "kx783ajyx962fqvwjf2pcv8ak98h8rq3",
            "identity": "instagram-source-identity-v1:DfEyHdfRQ2h",
            "key": "instagram-occurrence-v2:85bdcd92daf31ddc1eacddc56331626813c09247774a3a72f345120762f769ca",
            "fingerprint": "instagram-source-v2:a1dc5e7b6786e090ab3ea774c7302b2e4ce5f38adf8ed19cd33228730992b967",
            "documentId": "jn794n085gbfsdng71jfcn10fx8h8qrz",
            "postId": "4018557182546349473",
            "url": "https://www.instagram.com/p/DfEyHdfRQ2h/",
            "handle": "rikverc.bg"
          }
        ]
      }
    ]
  },
  "beton-los-tres-nov6": {
    "venueId": "k174b5bw553jtfbe0htdkyqvkn896jm3",
    "venueName": "Beton",
    "venueHandle": "betonbelgrade",
    "rows": [
      {
        "id": "j57f84b79damq09kxan158t1qn8hf6cz",
        "title": "LOS TRES",
        "date": "2026-11-06",
        "time": "22:00",
        "venue": "Beton",
        "venueId": "k174b5bw553jtfbe0htdkyqvkn896jm3",
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "DJ VUCHINA",
          "DJ WARDELL"
        ],
        "postId": "4021464012323620616",
        "url": "https://www.instagram.com/p/DfPHDZrkQcI/",
        "handle": "betonbelgrade",
        "key": "instagram-occurrence-v2:718297588cb34253baf832dcb3faee99eb35970369a5bb8b1bb86f01dba58693",
        "fieldsKey": "instagram-occurrence-v2:718297588cb34253baf832dcb3faee99eb35970369a5bb8b1bb86f01dba58693",
        "sources": [
          {
            "linkId": "kx7c029ac242v9t47sex0wcjsd8hf09t",
            "identity": "instagram-source-identity-v1:DfPHDZrkQcI",
            "key": "instagram-occurrence-v2:718297588cb34253baf832dcb3faee99eb35970369a5bb8b1bb86f01dba58693",
            "fingerprint": "instagram-source-v2:b59ab359c4d214f0e9459e230a455eec64a0135d6a6ea414f927f5e1525434bb",
            "documentId": "jn71acdk1363kwefdkrsyqmphs8hf3zz",
            "postId": "4021464012323620616",
            "url": "https://www.instagram.com/p/DfPHDZrkQcI/",
            "handle": "betonbelgrade"
          }
        ]
      },
      {
        "id": "j57ev5xm0dztqbyva9red58t4n8hfcjv",
        "title": "SUDAR",
        "date": "2026-11-06",
        "time": "22:00",
        "venue": "Klub Beton",
        "venueId": null,
        "status": "approved",
        "eventType": "nightlife",
        "artists": [
          "Vuchina",
          "Wardel"
        ],
        "postId": "4021494285092621318",
        "url": "https://www.instagram.com/p/DfPN77ZNYwG/",
        "handle": "lostreszurke",
        "key": "instagram-occurrence-v2:c5b37fbe16d606d07d736cd074ed0f6da389d4bd5cea0cdd0de44d46e82c457c",
        "fieldsKey": "instagram-occurrence-v2:c5b37fbe16d606d07d736cd074ed0f6da389d4bd5cea0cdd0de44d46e82c457c",
        "sources": [
          {
            "linkId": "kx72yn6drvpba3rh9tkgmed2bn8hersm",
            "identity": "instagram-source-identity-v1:DfPN77ZNYwG",
            "key": "instagram-occurrence-v2:c5b37fbe16d606d07d736cd074ed0f6da389d4bd5cea0cdd0de44d46e82c457c",
            "fingerprint": "instagram-source-v2:4839cbd8fedcf4e4480ab03d45640872dff12c39fc7e7ddc9b1786dd3246e916",
            "documentId": "jn7a40rm2et8v13ttvj1r8fcy98heavd",
            "postId": "4021494285092621318",
            "url": "https://www.instagram.com/p/DfPN77ZNYwG/",
            "handle": "lostreszurke"
          }
        ]
      }
    ],
    "nextDescription": "Los Tres predstavlja SUDAR uz DJ Vuchina i DJ Wardell. Ulaz 500 RSD; rezervacije u DM."
  }
};
const PROTECTED_PERFORMANCES: readonly { id: string; title: string; date: string; time: string }[] = [
  {
    "id": "j57davczg3efawp0xnw6hmg86d8eyq6j",
    "title": "JURA & FILM",
    "date": "2026-12-05",
    "time": "TBD"
  },
  {
    "id": "j57bcps5x8s9zs8ma39qbwwdr98he2y5",
    "title": "STABLO MASLINE",
    "date": "2026-11-06",
    "time": "18:30"
  },
  {
    "id": "j576qhgday1np01bdr8rffg5an8he0ze",
    "title": "PUKOTINA U LEDU",
    "date": "2026-11-06",
    "time": "20:30"
  },
  {
    "id": "j5787fm1q2dhhrq6pxv1xrd6xn8gsw36",
    "title": "The Nutcracker",
    "date": "2026-12-20",
    "time": "15:00"
  },
  {
    "id": "j5739mef9qz6e1hpc252t9d92d8gsxn9",
    "title": "The Nutcracker",
    "date": "2026-12-20",
    "time": "20:00"
  },
  {
    "id": "j57212bsaaskcc4hy9sqqb9p158hecc2",
    "title": "RIKVERC",
    "date": "2026-11-07",
    "time": "22:00"
  },
  {
    "id": "j579dvsa7dyarqhfj4nxk6qv0d8h43g9",
    "title": "Buzzcocks",
    "date": "2026-12-12",
    "time": "20:00"
  }
];

type ReadCtx = QueryCtx | MutationCtx;
const MAX_ROWS = 64;
const MAX_LINKS_PER_EVENT = 8;
const MAX_TOTAL_LINKS = 12;
const MAX_SAVES = 100;
const MAX_CONTEXT_BYTES = 3 * 1024 * 1024;
const fail = (message: string): never => { throw new Error(`Reviewed venue-links repair: ${message}`); };
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sorted = <T extends { _id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a._id.localeCompare(b._id));
function fieldsOf(event: Pick<Doc<"events">, "normalizedFieldsJson">): Record<string, unknown> {
  const fields: unknown = JSON.parse(event.normalizedFieldsJson ?? "null");
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fail("invalid normalized evidence.");
  return fields as Record<string, unknown>;
}
function digest(context: unknown): string {
  const value = stableJson(context);
  if (new TextEncoder().encode(value).byteLength > MAX_CONTEXT_BYTES) return fail("frozen context exceeds its bounded proof size.");
  return sha256Hex(value);
}
function reviewFor(groupKey: string): FrozenReview {
  if (!Object.hasOwn(VENUE_LINKS_NOVEMBER_2026_REVIEWS, groupKey)) return fail("unknown frozen cohort.");
  return VENUE_LINKS_NOVEMBER_2026_REVIEWS[groupKey]!;
}
async function requireService(ctx: ReadCtx, secret: string): Promise<string> {
  const auth = await requireAdminOrServiceSecret(ctx, secret);
  if (auth.kind !== "service") return fail("service authentication is required.");
  return auth.actor;
}
const operationFor = (groupKey: string) => `reviewed-venue-links-november-2026:${groupKey}:v1`;

async function assertOriginalSourceProof(ctx: ReadCtx, event: Doc<"events">, link: Doc<"instagramEventSources">,
  occurrence: Doc<"sourceOccurrences">, source: Doc<"scrapedPosts">) {
  const canonical = parseCanonicalEventPayload(occurrence.canonicalEventJson);
  if (!canonical || !source.analysisResultJson) return fail("original source canonical payload is missing.");
  const fields = fieldsOf(canonical);
  if (fields.sourceOccurrenceKey !== link.sourceOccurrenceKey || fields.sourceOccurrenceSourceFingerprint !== link.sourceFingerprint ||
    fields.sourceGroundingInstagramHandle !== source.handle || fields.sourceGroundingInstagramPostId !== source.postId ||
    fields.sourceGroundingInstagramPostUrl !== source.instagramPostUrl || (fields.sourceGroundingSourceCaption ?? "") !== (source.caption ?? "") ||
    typeof fields.title !== "string" || typeof fields.normalizedDate !== "string" || typeof fields.normalizedVenue !== "string" ||
    !Array.isArray(fields.artists) || fields.artists.some((artist) => typeof artist !== "string")) {
    return fail("immutable source canonical binding changed.");
  }
  const display = source.analysisCarouselImages?.find((image) => image.slideIndex === fields.carouselDisplaySlideIndex);
  const sourceCandidate: Doc<"events"> = { ...event, ...canonical, title: fields.title, date: fields.normalizedDate,
    sourceConflictFields: [...canonical.sourceConflictFields],
    venue: fields.normalizedVenue, artists: fields.artists as string[], status: "approved",
    instagramPostId: source.postId, instagramPostUrl: source.instagramPostUrl, sourceCaption: source.caption,
    sourcePostedAt: source.postedAt, rawExtractionJson: source.analysisResultJson,
    imageUrl: display?.url, imageStorageId: display?.storageId,
    normalizedFieldsJson: JSON.stringify({ ...fields, humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION }),
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt: event.updatedAt, reviewedBy: "service:reviewed-venue-links-source-proof",
    moderationNote: "Exact original retained source independently reviewed before the frozen venue-links consolidation." };
  if (!hasHumanReviewedStructuredSourceAttestation(sourceCandidate.normalizedFieldsJson, sourceCandidate) ||
    !(await isCanonicallyGroundedApprovedEvent(ctx, sourceCandidate))) return fail(`an original source lost its current persisted analysis proof: ${source.instagramPostUrl}`);
}

async function loadDistinctControlProof(ctx: ReadCtx, pin: FrozenRow, event: Doc<"events">) {
  const fields = fieldsOf(event);
  if (event._id !== pin.id || event.title !== pin.title || event.date !== pin.date || (event.time ?? "TBD") !== pin.time ||
    event.venue !== pin.venue || (event.venueId ?? null) !== pin.venueId || event.status !== pin.status || event.eventType !== pin.eventType ||
    !exactJsonValue(event.artists, [...pin.artists]) || event.instagramPostId !== pin.postId || event.instagramPostUrl !== pin.url ||
    event.sourceOccurrenceKey !== pin.key || fields.sourceOccurrenceKey !== pin.fieldsKey || fields.sourceGroundingInstagramHandle !== pin.handle ||
    isCrossPostCampaignLineageEvent(event)) return fail("the independently reviewed counterparty changed.");
  const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, event._id);
  if (topology.links.length !== pin.sources.length || topology.currentOccurrences.length !== pin.sources.length) return fail("independent counterparty topology changed.");
  const sources = [];
  for (const binding of pin.sources) {
    const link = topology.links.find((row) => row._id === binding.linkId);
    const occurrence = topology.currentOccurrences.find((row) => row.sourceIdentity === binding.identity && row.sourceOccurrenceKey === binding.key);
    if (!link || !occurrence || link.sourceIdentity !== binding.identity || link.sourceOccurrenceKey !== binding.key ||
      link.sourceFingerprint !== binding.fingerprint || occurrence.sourceFingerprint !== binding.fingerprint ||
      occurrence.sourceDocumentId !== binding.documentId || link.instagramPostId !== binding.postId || link.instagramPostUrl !== binding.url) return fail("independent counterparty source binding changed.");
    const source = await ctx.db.get(occurrence.sourceDocumentId);
    if (!source || source.handle !== binding.handle || source.postId !== binding.postId || source.instagramPostUrl !== binding.url ||
      source.analysisRevision !== (source.sourceRevision ?? 1) || occurrence.sourceRevision !== (source.sourceRevision ?? 1)) return fail("independent counterparty source revision changed.");
    await assertOriginalSourceProof(ctx, event, link, occurrence, source);
    sources.push(source);
  }
  return { event, links: topology.links, occurrences: topology.currentOccurrences, receipts: topology.receipts, sources };
}

async function loadContext(ctx: ReadCtx, groupKey: string) {
  const review = reviewFor(groupKey);
  const events: Doc<"events">[] = [];
  for (const pin of review.rows) {
    const event = await ctx.db.get(pin.id as Id<"events">);
    if (!event) return fail("a pinned event disappeared.");
    events.push(event);
  }
  const primary = events[0]!;
  const venue = await ctx.db.get(review.venueId as Id<"venues">);
  if (!venue || !isVenuePublic(venue) || venue.name !== review.venueName || venue.instagramHandle !== review.venueHandle) return fail("the exact public target venue changed.");
  const marker = fieldsOf(primary).reviewedNovember2026Repair as Record<string, unknown> | undefined;
  const complete = marker?.groupKey === groupKey && marker.role === "primary";
  const finalTitle = review.nextTitle ?? review.rows[0]!.title;
  const finalTime = review.nextTime ?? review.rows[0]!.time;
  const finalArtists = review.nextArtists ?? review.rows[0]!.artists;
  const componentIds = review.rows.slice(1).map((row) => row.id);
  const links: Doc<"instagramEventSources">[] = [];
  const occurrences: Doc<"sourceOccurrences">[] = [];
  const receiptsById = new Map<string, Doc<"instagramSourceOccurrenceReceipts">>();
  const sourcesById = new Map<string, Doc<"scrapedPosts">>();
  const selectedIds = new Set(events.map((event) => event._id));
  for (const [index, event] of events.entries()) {
    const pin = review.rows[index]!;
    const fields = fieldsOf(event);
    const eventMarker = fields.reviewedNovember2026Repair as Record<string, unknown> | undefined;
    if (event.date !== pin.date || event.title !== (complete && index === 0 ? finalTitle : pin.title) ||
      (event.time ?? "TBD") !== (complete && index === 0 ? finalTime : pin.time) || event.eventType !== pin.eventType ||
      !exactJsonValue(event.artists, complete && index === 0 ? [...finalArtists] : [...pin.artists]) ||
      event.instagramPostId !== pin.postId || event.instagramPostUrl !== pin.url || event.sourceOccurrenceKey !== pin.key ||
      fields.sourceOccurrenceKey !== pin.fieldsKey || fields.sourceGroundingInstagramHandle !== pin.handle ||
      event.venue !== (complete && index === 0 ? venue.name : pin.venue) ||
      (event.venueId ?? null) !== (complete && index === 0 ? venue._id : pin.venueId) ||
      event.status !== (complete ? index === 0 ? "approved" : "rejected" : pin.status) ||
      (!complete && isCrossPostCampaignLineageEvent(event)) ||
      (complete && (eventMarker?.groupKey !== groupKey || eventMarker.operationId !== operationFor(groupKey) ||
        eventMarker.role !== (index === 0 ? "primary" : "component") || eventMarker.primaryId !== primary._id ||
        !exactJsonValue(eventMarker.componentIds, componentIds))) ||
      (complete && index === 0 && review.nextDescription !== undefined && event.description !== review.nextDescription) ||
      fields.extractionContractVersion !== "event_evidence_v2" || fields.extractionIsEvent !== true ||
      fields.sourceGroundingVersion !== 5 || fields.sourceGroundingEvidence !== "persisted_openai_event_evidence_v2") return fail("a frozen original event or source binding changed.");
    const eventLinks = complete
      ? (await Promise.all(pin.sources.map((source) => ctx.db.query("instagramEventSources")
          .withIndex("by_source_occurrence", (q) => q.eq("sourceIdentity", source.identity).eq("sourceOccurrenceKey", source.key)).take(2)))).flat()
      : await ctx.db.query("instagramEventSources").withIndex("by_event", (q) => q.eq("eventId", event._id)).take(MAX_LINKS_PER_EVENT + 1);
    if (eventLinks.length !== pin.sources.length || eventLinks.length > MAX_LINKS_PER_EVENT) return fail("original source-link cohort changed.");
    for (const sourcePin of pin.sources) {
      const link = eventLinks.find((row) => row._id === sourcePin.linkId);
      if (!link || link.eventId !== (complete ? primary._id : event._id) || link.sourceIdentity !== sourcePin.identity ||
        link.sourceOccurrenceKey !== sourcePin.key || link.sourceFingerprint !== sourcePin.fingerprint ||
        link.instagramPostId !== sourcePin.postId || link.instagramPostUrl !== sourcePin.url) return fail("a frozen source-link coordinate changed.");
      const occurrenceRows = link.sourceOccurrenceId ? [await ctx.db.get(link.sourceOccurrenceId)]
        : await ctx.db.query("sourceOccurrences").withIndex("by_source_occurrence", (q) => q.eq("sourceIdentity", link.sourceIdentity).eq("sourceOccurrenceKey", link.sourceOccurrenceKey)).take(2);
      const occurrence = occurrenceRows.length === 1 ? occurrenceRows[0] : null;
      if (!occurrence || occurrence.state !== "satisfied" || occurrence.canonicalEventId !== (complete ? primary._id : event._id) ||
        occurrence.sourceIdentity !== sourcePin.identity || occurrence.sourceOccurrenceKey !== sourcePin.key ||
        occurrence.sourceFingerprint !== sourcePin.fingerprint || occurrence.sourceDocumentId !== sourcePin.documentId) return fail("a retained first-class occurrence changed.");
      const receiptRows = await ctx.db.query("instagramSourceOccurrenceReceipts").withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", sourcePin.identity)).take(2);
      if (receiptRows.length !== 1) return fail("source receipt is not unique.");
      const receipt = receiptRows[0]!;
      assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
      const expected = receipt.expectedOccurrences?.filter((row) => row.key === sourcePin.key) ?? [];
      const satisfied = receipt.satisfiedOccurrences.filter((row) => row.key === sourcePin.key);
      if (receipt.sourceFingerprint !== sourcePin.fingerprint || expected.length !== 1 || satisfied.length !== 1 ||
        satisfied[0]!.eventId !== (complete ? primary._id : event._id) ||
        !sourceOccurrenceRepresentativeMatchesExpected(complete ? primary : event, expected[0]) ||
        receipt.deferredChildCount !== 0 || receipt.deferredChildKeys.length !== 0 ||
        receipt.expectedKeys.length !== receipt.satisfiedKeys.length || receipt.expectedKeys.length > MAX_ROWS) return fail("a selected receipt is incomplete or inconsistent.");
      const source = await ctx.db.get(occurrence.sourceDocumentId);
      if (!source || source.handle !== sourcePin.handle || source.postId !== sourcePin.postId || source.instagramPostUrl !== sourcePin.url ||
        source.analysisRevision !== (source.sourceRevision ?? 1) || occurrence.sourceRevision !== (source.sourceRevision ?? 1) ||
        source.analysisContractVersion !== "event_evidence_v2" || source.analysisIsEvent !== true || !isSupportedExtractionModel(source.analysisModel)) return fail("persisted source author, analysis or revision changed.");
      if (source.instagramPostUrl === event.instagramPostUrl &&
        (source.analysisResultJson !== event.rawExtractionJson || (source.caption ?? "") !== (event.sourceCaption ?? "") || source.postedAt !== event.sourcePostedAt)) return fail("original event source evidence changed.");
      await assertOriginalSourceProof(ctx, event, link, occurrence, source);
      links.push(link); occurrences.push(occurrence); receiptsById.set(receipt._id, receipt); sourcesById.set(source._id, source);
    }
  }
  if (links.length > MAX_TOTAL_LINKS || new Set(links.map((link) => link._id)).size !== links.length) return fail("selected source cohort exceeds its safe bound.");
  const siblingsById = new Map<string, Doc<"events">>();
  for (const receipt of receiptsById.values()) for (const satisfaction of receipt.satisfiedOccurrences) {
    if (selectedIds.has(satisfaction.eventId)) continue;
    const sibling = await ctx.db.get(satisfaction.eventId);
    const expected = receipt.expectedOccurrences?.filter((row) => row.key === satisfaction.key) ?? [];
    if (!sibling || expected.length !== 1 || !sourceOccurrenceRepresentativeMatchesExpected(sibling, expected[0])) return fail("an unrelated receipt sibling is incomplete.");
    siblingsById.set(sibling._id, sibling);
    if (siblingsById.size > MAX_ROWS) return fail("receipt sibling bound exceeded.");
  }
  const evidenceSources = [];
  for (const pin of review.evidenceSources ?? []) {
    const source = await ctx.db.get(pin.id as Id<"scrapedPosts">);
    if (!source || source.postId !== pin.postId || source.instagramPostUrl !== pin.url || source.handle !== pin.handle ||
      sha256Hex(source.caption ?? "") !== pin.captionSha256) return fail("a frozen joint-program source changed.");
    evidenceSources.push(source);
  }
  const protectedEvents = [];
  for (const pin of PROTECTED_PERFORMANCES) {
    const event = await ctx.db.get(pin.id as Id<"events">);
    if (!event || event.title !== pin.title || event.date !== pin.date || (event.time ?? "TBD") !== pin.time || event.status !== "approved" || selectedIds.has(event._id)) return fail("a protected independent performance changed.");
    protectedEvents.push(event);
  }
  const distinctProofs = [];
  for (const pin of review.distinctControls ?? []) {
    const event = protectedEvents.find((row) => row._id === pin.id);
    if (!event) return fail("an independent counterparty must be in the protected set.");
    distinctProofs.push(await loadDistinctControlProof(ctx, pin, event));
  }
  const saves = [];
  for (const event of events) {
    const refs = await savedEventRepository.loadEventReferences(ctx, event._id, { limit: MAX_SAVES });
    if (complete && event._id !== primary._id && (refs.canonical.length || refs.legacy.length)) return fail("an applied component retains saved references.");
    saves.push({ eventId: event._id, canonical: sorted(refs.canonical), legacy: sorted(refs.legacy) });
  }
  if (complete) {
    const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
    if (topology.links.length !== links.length || topology.currentOccurrences.length !== occurrences.length || !(await isEventPubliclyVisible(ctx, primary))) return fail("applied primary publication or provenance is incomplete.");
    for (const event of events.slice(1)) {
      const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, event._id);
      if (topology.links.length || topology.occurrences.length || topology.receipts.length) return fail("an applied component retained provenance.");
    }
  }
  return { groupKey, complete, primaryId: primary._id, events, links, occurrences, receipts: sorted([...receiptsById.values()]),
    sources: sorted([...sourcesById.values()]), venue, siblings: sorted([...siblingsById.values()]), evidenceSources, protectedEvents, distinctProofs, saves };
}

export async function getReviewedVenueLinksNovember2026ContextHandler(ctx: QueryCtx, args: { groupKey: string; serviceSecret: string }) {
  ctx = withNovember2026ReadCache(ctx); await requireService(ctx, args.serviceSecret);
  const context = await loadContext(ctx, args.groupKey); return { ...context, contextSha256: digest(context) };
}

export async function consolidateReviewedVenueLinksNovember2026Handler(ctx: MutationCtx,
  args: { groupKey: string; expectedContextSha256: string; moderationNote: string; serviceSecret: string }) {
  ctx = withNovember2026ReadCache(ctx); const actor = await requireService(ctx, args.serviceSecret);
  const note = args.moderationNote.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (note.length < 30 || note.length > 1000 || !/^[a-f0-9]{64}$/u.test(args.expectedContextSha256)) return fail("exact context and substantive review note are required.");
  const context = await loadContext(ctx, args.groupKey);
  if (context.complete) return fail("cohort is already applied; inspect its final context.");
  if (digest(context) !== args.expectedContextSha256) return fail("reviewed context changed; preview again.");
  const review = reviewFor(args.groupKey); const primary = context.events[0]!; const components = context.events.slice(1);
  const selectedIds = new Set(context.events.map((event) => event._id)); const now = Date.now();
  const title = review.nextTitle ?? primary.title; const artists = [...(review.nextArtists ?? primary.artists)];
  const description = review.nextDescription ?? primary.description;
  const time = review.nextTime ?? primary.time;
  const timeDonor = review.nextTime ? context.events.find((event) => event._id === review.timeDonorId) : undefined;
  if (review.nextTime && (!timeDonor || timeDonor.status !== "approved" || timeDonor.time !== review.nextTime)) return fail("the frozen time donor changed.");
  const timePatch = timeDonor ? normalizeEventTimeWritePatch({ time: review.nextTime,
    timeSource: timeDonor.timeSource ?? "unknown", timeEvidenceText: timeDonor.timeEvidenceText ?? null,
    timeConfidence: timeDonor.timeConfidence ?? 0, timeStatus: timeDonor.timeStatus ?? "unknown",
    timeEvidenceKind: timeDonor.timeEvidenceKind ?? "start_time_stated" }) : {};
  const marker = { policyVersion: 1, operationId: operationFor(args.groupKey), groupKey: args.groupKey,
    primaryId: primary._id, componentIds: components.map((event) => event._id), reviewedAt: now, reviewedBy: actor };
  const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues([context.venue], review.venueName);
  if (venueFields.venueId !== context.venue._id) return fail("the canonical venue did not resolve exactly.");
  const nextFields = { ...fieldsOf(primary), title, time, artists, ...(description !== undefined ? { description } : {}),
    ...(timeDonor ? { reviewedTimeCorrection: { policyVersion: 1, previousTime: primary.time ?? null,
      time, sourceEventId: timeDonor._id, evidence: timeDonor.timeEvidenceText ?? null } } : {}),
    normalizedVenue: review.venueName, moderationAutoApproved: false, moderationAutoApproveRule: null,
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedVenueCorrection: { policyVersion: 1, reviewedAt: now, reviewedBy: actor, previousVenue: primary.venue,
      venue: review.venueName, evidence: "Exact source-reviewed frozen venue and same-program cohort." },
    reviewedNovember2026Repair: { ...marker, role: "primary" } };
  const candidate: Doc<"events"> = { ...primary, ...venueFields, ...timePatch, venue: review.venueName, title, artists,
    ...(description !== undefined ? { description } : {}), normalizedFieldsJson: JSON.stringify(nextFields),
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt: now, reviewedBy: actor, moderationNote: note };
  if (!hasHumanReviewedStructuredSourceAttestation(candidate.normalizedFieldsJson, candidate)) return fail("review did not bind the final public payload.");
  if (hasHumanReviewableStructuredSourceAttestation(candidate.normalizedFieldsJson, candidate)) await assertPersistedServiceSourcePolicy(ctx, candidate, { allowHumanReviewedStructured: true });
  const expectedAmbiguousApprovedEventVersions = context.distinctProofs
    .filter((proof) => classifyApprovalCandidates(candidate, proof.event) === "ambiguous")
    .map((proof) => ({ id: proof.event._id, updatedAt: proof.event.updatedAt }));
  // Only a frozen independently source-proved counterparty can resolve an
  // ambiguity. Proven duplicates and any unreviewed conflict still fail closed.
  await assertApprovalCandidatePolicy(ctx, candidate, context.events.map((event) => event._id), { expectedAmbiguousApprovedEventVersions });
  if (!(await isCanonicallyGroundedApprovedEvent(ctx, candidate))) return fail("final primary source proof failed.");
  const topologies = [];
  for (const event of components) topologies.push(await prepareInstagramOccurrenceTopologyForDedicatedReattestation(ctx, event._id));
  await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
  const siblingStates = [];
  for (const event of context.siblings) siblingStates.push({ event, decision: await evaluateEventPublication(ctx, event), visible: await isEventPubliclyVisible(ctx, event, { allowNeverMigratedApproved: true }) });
  const plans = context.receipts.map((receipt) => {
    const keys = new Set(context.links.filter((link) => link.sourceIdentity === receipt.sourceIdentity).map((link) => link.sourceOccurrenceKey));
    return { receipt, expectedOccurrences: receipt.expectedOccurrences!.map((row) => keys.has(row.key)
      ? { ...row, title, date: primary.date, time, venue: review.venueName, artists } : row),
    satisfiedOccurrences: receipt.satisfiedOccurrences.map((row) => selectedIds.has(row.eventId) ? { ...row, eventId: primary._id } : row) };
  });
  for (const plan of plans) for (const row of plan.satisfiedOccurrences) {
    const expected = plan.expectedOccurrences.filter((item) => item.key === row.key);
    if (expected.length !== 1 || !sourceOccurrenceRepresentativeMatchesExpected(row.eventId === primary._id ? candidate : await ctx.db.get(row.eventId), expected[0])) return fail("a receipt satisfaction would be invalidated.");
  }
  const primaryUpdatedAt = nextEventUpdatedAt(primary.updatedAt, now);
  await ctx.db.patch(primary._id, { ...venueFields, ...timePatch, ...buildEventOccurrenceIndexPatch(candidate), venue: review.venueName, title, artists,
    ...(description !== undefined ? { description } : {}), normalizedFieldsJson: candidate.normalizedFieldsJson,
    humanReviewedStructuredSourcePolicyVersion: HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
    reviewedAt: now, reviewedBy: actor, moderationNote: note, updatedAt: primaryUpdatedAt });
  for (const plan of plans) await ctx.db.patch(plan.receipt._id, { expectedOccurrences: plan.expectedOccurrences,
    satisfiedOccurrences: plan.satisfiedOccurrences, updatedAt: nextEventUpdatedAt(plan.receipt.updatedAt, now) });
  let movedSaveCount = 0; let dedupedSaveCount = 0;
  for (const [index, event] of components.entries()) {
    await ctx.db.patch(event._id, { status: "rejected", normalizedFieldsJson: JSON.stringify({ ...fieldsOf(event), reviewedNovember2026Repair: { ...marker, role: "component" } }),
      reviewedAt: now, reviewedBy: actor, moderationNote: `[reviewed_november_component:v1] ${marker.operationId} - ${note}`, updatedAt: nextEventUpdatedAt(event.updatedAt, now) });
    await reassignInstagramOccurrenceReferences(ctx, event._id, primary._id, topologies[index]!);
    const saves = await reassignSavedEventReferences(ctx, event._id, primary._id); movedSaveCount += saves.movedCount; dedupedSaveCount += saves.dedupedCount;
  }
  for (const link of context.links) {
    const plan = plans.find((item) => item.receipt.sourceIdentity === link.sourceIdentity)!;
    await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(ctx, { expected: plan.expectedOccurrences.find((row) => row.key === link.sourceOccurrenceKey)!,
      representative: candidate, sourceFingerprint: link.sourceFingerprint, sourceLink: link, topologyEpochVerified: true });
  }
  const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, primary._id);
  if (topology.links.length !== context.links.length || topology.currentOccurrences.length !== context.occurrences.length) return fail("final primary provenance is incomplete.");
  await sourceOccurrenceProvenanceRepository.assertEventMatchesBoundOccurrences(ctx, primary._id, candidate);
  for (const event of components) {
    const topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(ctx, event._id);
    if (topology.links.length || topology.occurrences.length || topology.receipts.length) return fail("a rejected component retained provenance.");
  }
  for (const before of context.occurrences) {
    const after = await ctx.db.get(before._id);
    if (!after || after.factsJson !== before.factsJson || after.canonicalEventJson !== before.canonicalEventJson ||
      after.sourceRevision !== before.sourceRevision || after.sourceDocumentId !== before.sourceDocumentId || after.sourceFingerprint !== before.sourceFingerprint) return fail("immutable occurrence evidence changed.");
  }
  for (const source of [...context.sources, ...context.evidenceSources, ...context.distinctProofs.flatMap((proof) => proof.sources)]) if (!exactJsonValue(await ctx.db.get(source._id), source)) return fail("an original source document changed.");
  for (const event of context.events) await refreshCanonicalEventDerivedStates(ctx, [event._id]);
  const published = await ctx.db.get(primary._id);
  if (!published || (await evaluateEventPublication(ctx, published)).state !== "publishable" || !(await isEventPubliclyVisible(ctx, published))) return fail("retained primary is not public.");
  for (const before of siblingStates) {
    const after = await ctx.db.get(before.event._id);
    if (!after || !exactJsonValue(after, before.event) || !exactJsonValue(await evaluateEventPublication(ctx, after), before.decision) ||
      (before.visible && !(await isEventPubliclyVisible(ctx, after)))) return fail("an unrelated receipt sibling changed or lost publication.");
  }
  for (const before of context.protectedEvents) if (!exactJsonValue(await ctx.db.get(before._id), before)) return fail("a protected independent performance changed.");
  for (const before of context.events) {
    const after = await ctx.db.get(before._id);
    if (!after || after.rawExtractionJson !== before.rawExtractionJson || after.sourceCaption !== before.sourceCaption || after.sourcePostedAt !== before.sourcePostedAt ||
      after.instagramPostId !== before.instagramPostId || after.instagramPostUrl !== before.instagramPostUrl || after.imageStorageId !== before.imageStorageId) return fail("original event evidence changed.");
    await writeEventAuditLog(ctx, before._id, before._id === primary._id ? "reviewed_venue_links_november_consolidated" : "reviewed_venue_links_november_component_rejected", {
      actor, note, patch: { ...marker, before, next: { title, artists, venue: review.venueName, time: time ?? null, description: description ?? null },
        sourceLinksBefore: context.links.filter((link) => link.eventId === before._id), movedSaveCount, dedupedSaveCount } });
  }
  return { groupKey: args.groupKey, primaryId: primary._id, rejectedIds: components.map((event) => event._id), primaryUpdatedAt, movedSaveCount, dedupedSaveCount };
}

export const stableVenueLinksNovember2026ContextJson = stableJson;
