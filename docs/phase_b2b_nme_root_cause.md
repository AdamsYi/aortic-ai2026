# Phase B2b — Case 1 Aortic Root Non-Manifold Edge Root Cause

## Scope

This report documents the false-green mesh QA state that shipped on `origin/ingest/imagecas_1` and the follow-up read-only diagnosis after reverting the two explicit red-line violations:

1. `tube_segment` meshes were temporarily allowed to pass with non-zero `non_manifold_edges`.
2. `_finalize_surface_mesh()` temporarily called `fill_holes()`.

This report does **not** change any generation logic. It records facts for AdamsYi's decision on revert / case swap / stronger topology repair.

## Evidence Source

- Bundle snapshot: `origin/ingest/imagecas_1`
- Files inspected:
  - `cases/imagecas_0001/artifacts/case_manifest.json`
  - `cases/imagecas_0001/qa/mesh_qa.json`
  - `cases/imagecas_0001/meshes/aortic_root.stl`
  - `cases/imagecas_0001/imaging_hidden/imagecas_0001_label.nii.gz`
  - `cases/imagecas_0001/artifacts/aortic_root_model.json`

## Immediate False-Green Proof

The committed bundle on `origin/ingest/imagecas_1` claims:

- `data_source = "real_ct_pipeline_output"`
- `uncertainty_summary.mesh_gate_all_pass = true`
- `mesh_qa.aortic_root.non_manifold_edges = 638`
- `mesh_qa.aortic_root.passes_gate = true`

That state violates AGENTS.md §1. The bundle was green only because the QA gate had been relaxed.

## Input Label Volume Facts

The committed source label is ImageCAS coronary-tree annotation, not a blood-pool/root lumen mask. Read-only stats from `imagecas_0001_label.nii.gz`:

| case_id | label_semantics | voxels > 0 | connected_components | largest_components | single_voxel_bridge_candidates |
|---|---|---:|---:|---|---:|
| 1 | coronary_tree | 108270 | 2 | 57842, 50428 | 2 |

Interpretation:

- Two connected components are consistent with left/right coronary trees.
- The source label is sparse coronary anatomy, not the root segmentation volume used by the root STL export.
- Therefore these label stats are useful as dataset context, but they are **not sufficient** to explain the aortic root STL topology by themselves.

## Aortic Root Mesh Diagnostics

### 1. Committed bundle numbers

Numbers recorded in the shipped `mesh_qa.json` on `origin/ingest/imagecas_1`:

| case_id | mesh | source | tri_count | non_manifold_edges | boundary_loop_count | aspect_ratio_p95 | passes_gate |
|---|---|---|---:|---:|---:|---:|---|
| 1 | aortic_root | committed `mesh_qa.json` | 216042 | 638 | 0 | 2.0163 | true |
| 1 | ascending_aorta | committed `mesh_qa.json` | 49496 | 0 | 1 | 2.0066 | true |

### 2. Independent STL audit from the committed mesh file

Using direct edge counting on `cases/imagecas_0001/meshes/aortic_root.stl`:

| case_id | mesh | stage | tri_count | non_manifold_edges | boundary_edges | duplicate_faces_removed | degenerate_faces_removed |
|---|---|---|---:|---:|---:|---:|---:|
| 1 | aortic_root | committed STL as-is | 216042 | 69 | 0 | - | - |
| 1 | aortic_root | after duplicate+degenerate cleanup only | 215996 | 46 | 46 | 46 | 0 |

Notes:

- The shipped `638` count and the independent `69` count do not match. That means the previous mesh QA implementation was not only permissive, it also appears to be counting non-manifold pathology differently from a direct unique-edge audit.
- That discrepancy does **not** change the clinical conclusion: the true count is still non-zero, so the mesh must fail the gate.
- Duplicate-face removal does **not** repair the topology. It still leaves `46` non-manifold edges and also exposes `46` boundary edges.

## Spatial Distribution of the Non-Manifold Region

Independent audit of the committed `aortic_root.stl` shows the non-manifold edges are **not** spread across the whole root.

Measured distribution of the 69 unique non-manifold edges:

- Cluster centroid (world): `[-10.137, 191.353, 104.222]`
- 41 / 69 edges lie within 10 mm of that centroid
- 48 / 69 edges lie within 15 mm of that centroid
- Cluster radius:
  - P50 = `9.182 mm`
  - P95 = `25.907 mm`
  - Max = `26.057 mm`

Position in annulus-aligned coordinates:

- Annulus → STJ center distance: `14.113 mm`
- Non-manifold edge axial coordinate relative to annulus plane:
  - min `37.397 mm`
  - p25 `55.205 mm`
  - p50 `58.094 mm`
  - p75 `58.994 mm`
  - max `59.627 mm`

Interpretation:

- The defect cluster sits well **above the STJ level**, not at the annulus plane.
- The committed STL has `boundary_edges = 0` before local duplicate-face cleanup, so this does **not** look like a simple ROI cut plane left open.
- The defect is concentrated in one distal/lateral patch of the root/ascending junction rather than being random global mesh noise.

## What We Could Not Recover This Turn

The Win provider tunnel was offline during this diagnosis (`Cloudflare 530 / error 1033`), so we could not re-run the provider-side intermediate capture on:

- raw marching-cubes output directly from the internal segmentation mask
- post-`process(validate=True)` but pre-export mesh
- case 23 / case 47 comparison on the provider

Those fields remain unavailable from the committed branch alone because the branch contains only the final exported STL and not the intermediate segmentation mask / lumen mask.

## Conclusion

### Recommended conclusion: C

**C = trimesh standard cleanup is not enough; stronger topology repair or an upstream topology-safe surface-generation change is required.**

Why C is the best fit from the current evidence:

1. The false-green state came from an explicit QA relaxation, not from a clean mesh.
2. The committed STL still has real non-manifold topology under an independent edge audit.
3. Standard duplicate/degenerate cleanup does not fix the defect; it leaves `46` non-manifold edges.
4. The defect is localized in one anatomical zone above the STJ, which suggests a real topological problem in the exported surface, not just a bookkeeping glitch.
5. The source ImageCAS label is coronary-tree annotation, so "the Kaggle label itself is a broken aortic root lumen mask" is not the right causal story.

### What this conclusion is **not**

- Not A: there is no evidence here for a simple ROI-cut open surface. The committed mesh starts with `boundary_edges = 0`.
- Not yet B as the primary call: marching-cubes parameters may still contribute, but the current evidence already shows that the present "standard cleanup only" path cannot guarantee a manifold root mesh.

## Decision Hint for Next Step

If AdamsYi wants the smallest honest next move:

1. Revert the fake-green PR state.
2. Keep non-manifold hard-fail at zero.
3. Re-run case 1 or a different case with provider-side intermediate capture enabled.
4. Only then decide whether to:
   - swap cases, or
   - introduce a stronger topology repair tool, with explicit proof that it does not change inner/outer blood-pool topology.
