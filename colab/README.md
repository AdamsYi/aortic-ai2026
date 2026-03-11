# Colab Zero-Dollar Demo

## Run in Google Colab

1. Upload `zero_dollar_demo.py` to Colab runtime.
2. Execute:

```bash
pip install requests
python zero_dollar_demo.py
```

It will:
- download open-source CT sample
- upload to your Cloudflare Worker
- create and poll a segmentation job
- save outputs in `run_outputs/<study_id>/`

Open-source sample used:
- TotalSegmentator test file: `example_ct.nii.gz`
- URL: https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/tests/reference_files/example_ct.nii.gz
- Repository: https://github.com/wasserth/TotalSegmentator
