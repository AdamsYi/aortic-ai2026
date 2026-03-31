@echo off
echo [AorticAI] Pre-downloading TotalSegmentator model weights...
echo This may take 5-10 minutes on first run.
cd /d "%~dp0"
call .venv\Scripts\activate.bat
python -c "import shutil,tempfile,subprocess; from pathlib import Path; import numpy as np, nibabel as nib; td=Path(tempfile.mkdtemp(prefix='aorticai-ts-preload-')); inp=td/'dummy.nii.gz'; out=td/'out'; nib.save(nib.Nifti1Image(np.zeros((32,32,32),dtype=np.int16), np.diag([1,1,1,1])), str(inp)); bin_path=shutil.which('TotalSegmentator') or shutil.which('totalsegmentator'); assert bin_path, 'TotalSegmentator CLI not found'; subprocess.check_call([bin_path,'-i',str(inp),'-o',str(out),'--task','total','--fast']); print('Model check complete')" 2>&1
echo [AorticAI] Done. Models are cached and ready.
pause
