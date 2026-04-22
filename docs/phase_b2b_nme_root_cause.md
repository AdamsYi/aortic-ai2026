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
- One-shot local probe script: `/tmp/imagecas_case1_seam_probe.py`
- One-shot local probe output: `/tmp/imagecas_case1_seam_probe.json`

## Correction of the Previous Wrong Premise

The previous version of this report incorrectly treated the ImageCAS Kaggle `coronary_tree` label as the direct source of `aortic_root.stl`.

That premise was wrong.

The actual generation chain for case 1 is:

1. `fetch_imagecas.py` sends the **CT volume only** into `pipeline_runner.py`
2. `build_real_multiclass_mask.py` runs TotalSegmentator open-task aorta segmentation
3. The provider builds a **multiclass** volume:
   - `1 = aortic_root`
   - `2 = valve_leaflets`
   - `3 = ascending_aorta`
4. `pipeline_runner.py` exports `aortic_root.stl` from `root_mask == 1`
5. `pipeline_runner.py` exports `ascending_aorta.stl` from `ascending_mask == 3`

So the Kaggle coronary-tree label is relevant as dataset metadata, but it is **not** the direct input mesh source for the root STL.

## Immediate False-Green Proof

The committed bundle on `origin/ingest/imagecas_1` claims:

- `data_source = "real_ct_pipeline_output"`
- `uncertainty_summary.mesh_gate_all_pass = true`
- `mesh_qa.aortic_root.non_manifold_edges = 638`
- `mesh_qa.aortic_root.passes_gate = true`

That state violates AGENTS.md §1. The bundle was green only because the QA gate had been relaxed.

## Dataset Label Facts (Corrected Scope)

The committed source label is ImageCAS coronary-tree annotation, not a blood-pool/root lumen mask. Read-only stats from `imagecas_0001_label.nii.gz`:

| case_id | label_semantics | voxels > 0 | connected_components | largest_components | single_voxel_bridge_candidates |
|---|---|---:|---:|---|---:|
| 1 | coronary_tree | 108270 | 2 | 57842, 50428 | 2 |

Interpretation:

- Two connected components are consistent with left/right coronary trees.
- The source label is sparse coronary anatomy.
- It is useful as dataset context only.
- It cannot by itself explain the committed `aortic_root.stl`, because that STL is produced from the provider's TotalSegmentator-derived multiclass mask.

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

## Seam Hypothesis Verification

### Target hypothesis

The new hypothesis to test was:

> `root_mask` and `ascending_mask` are split from the same multiclass volume; if their seam is the real defect source, the root non-manifold cluster should localize near the root↔ascending transition band.

### Exact mask-level replay status

The exact requested replay could not be completed this turn because:

- `segmentation_mask.nii.gz` was **not** committed into `origin/ingest/imagecas_1`
- the Win provider tunnel was offline during this task (`Cloudflare 530 / error 1033`)

So the exact pair of numbers below remains unavailable for now:

- root-only mesh from committed multiclass mask before `_finalize_surface_mesh()`
- merged `(root|ascending)` mask mesh before `_finalize_surface_mesh()`

### Available proxy test from committed geometry

Even without the intermediate multiclass file, the committed root and ascending STLs already let us test the seam hypothesis spatially.

If the seam were the main cause, the root non-manifold edge cluster should sit close to the ascending mesh.

Measured from the 69 independent root non-manifold edge midpoints to the nearest ascending-aorta mesh vertex:

| metric | value |
|---|---:|
| min distance to ascending mesh | 44.98 mm |
| p50 distance to ascending mesh | 57.37 mm |
| p95 distance to ascending mesh | 63.73 mm |
| count within 10 mm of ascending mesh | 0 / 69 |
| annulus → STJ center distance | 14.20 mm |

Interpretation:

- The bad-edge cluster is **not** sitting on the root↔ascending seam.
- The cluster is tens of millimeters away from the ascending mesh.
- Therefore the current evidence **refutes** the seam-as-primary-root-cause hypothesis on the committed geometry.

### Verification table

| case_id | artifact | metric | value | readout |
|---|---|---|---:|---|
| 1 | committed root STL | root-only non-manifold edges | 69 | independent direct edge audit |
| 1 | committed root STL after duplicate+degenerate cleanup | root-only non-manifold edges | 46 | still fails |
| 1 | committed root STL | nearest ascending distance min | 44.98 mm | too far for seam explanation |
| 1 | committed root STL | nearest ascending distance p50 | 57.37 mm | too far for seam explanation |
| 1 | committed root STL | nearest ascending distance p95 | 63.73 mm | too far for seam explanation |
| 1 | committed root STL | within 10 mm of ascending mesh | 0 / 69 | seam hypothesis not supported |

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
- The defect is concentrated in one distal/lateral patch of the root mesh.
- Combined with the ascending-distance measurements, this patch is **not** behaving like a root↔ascending split seam.

## What We Could Not Recover This Turn

The Win provider tunnel was offline during this diagnosis (`Cloudflare 530 / error 1033`), so we could not re-run the provider-side intermediate capture on:

- raw marching-cubes output directly from the internal segmentation mask
- post-`process(validate=True)` but pre-export mesh
- case 23 / case 47 comparison on the provider
- exact root-only vs merged `(root|ascending)` mask replay from `segmentation_mask.nii.gz`

Those fields remain unavailable from the committed branch alone because the branch contains only the final exported STL and not the intermediate segmentation mask / lumen mask.

## Conclusion

### Recommended conclusion: B'

**B' = the dominant problem is upstream voxel-label roughness / branch-stub geometry inside the root mask before export, not the root↔ascending split seam.**

Why B' is the best fit from the current evidence:

1. The false-green state came from an explicit QA relaxation, not from a clean mesh.
2. The committed STL still has real non-manifold topology under an independent edge audit.
3. Standard duplicate/degenerate cleanup does not fix the defect; it leaves `46` non-manifold edges.
4. The defect cluster is tens of millimeters away from the ascending mesh, so the seam hypothesis is not supported by the committed geometry.
5. The actual mesh source is the provider multiclass root mask, not the Kaggle coronary-tree label.

### What this conclusion is **not**

- Not A': the committed bad-edge cluster is not sitting on the root↔ascending seam.
- Not C' as the current best call: there is no positive evidence yet that the seam contributes materially to case 1.

## Decision Hint for Next Step

If AdamsYi wants the smallest honest next move:

1. Revert the fake-green PR state.
2. Keep non-manifold hard-fail at zero.
3. Re-run case 1 with provider-side intermediate capture enabled, specifically preserving:
   - `segmentation_mask.nii.gz`
   - root-only marching-cubes mesh before cleanup
   - merged `(root|ascending)` marching-cubes mesh before cleanup
4. If the mask-level replay still shows defects away from the seam, treat this as an upstream root-mask roughness problem and test topology-safe morphological smoothing before marching cubes, with explicit measurement-regression checks.
