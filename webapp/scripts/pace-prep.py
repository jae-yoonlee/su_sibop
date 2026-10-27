# FLEURS ko_kr dev → 빠르기별(1.0·0.8·1.25·1.5배, ffmpeg atempo) 소리(.f32) + Silero 확률 JSON. 데이터는 저장소 밖에 둔다.
# 받기: curl -r 0-260000000 https://storage.googleapis.com/xtreme_translations/FLEURS102/ko_kr.tar.gz | tar xz  (앞쪽 dev만, 약 260MB)
# 사용: python -I scripts/pace-prep.py <ko_kr 폴더> <출력 폴더> public/vad/silero_vad_v5.onnx  (pip: onnxruntime numpy soundfile, ffmpeg 필요)
import sys, os, json, subprocess, numpy as np, soundfile as sf, onnxruntime as ort
src, out, onnx = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
sess = ort.InferenceSession(onnx)
def probs(x):
    st = np.zeros((2,1,128), np.float32); sr = np.array(16000, np.int64); ps=[]
    for i in range(0, len(x)-511, 512):
        o, st = sess.run(None, {"input": x[i:i+512][None].astype(np.float32), "state": st, "sr": sr})
        ps.append(float(o[0][0]))
    return ps
rows=[l.rstrip("\n").split("\t") for l in open(f"{src}/dev.tsv", encoding="utf-8")]
for tempo in ["1.0","0.8","1.25","1.5"]:
    items=[]
    for r in rows:
        wav=f"{src}/audio/dev/{r[1]}"
        if tempo=="1.0": x,_=sf.read(wav, dtype="float32")
        else:
            raw=subprocess.run(["ffmpeg","-v","quiet","-i",wav,"-filter:a",f"atempo={tempo}","-ar","16000","-ac","1","-f","f32le","-"],capture_output=True).stdout
            x=np.frombuffer(raw,np.float32).copy()
        fn=f"{out}/{tempo}_{r[1]}.f32"; x.astype(np.float32).tofile(fn)
        items.append({"id":r[0],"file":fn,"text":r[2],"gender":r[6],"p":probs(x)})
    json.dump(items, open(f"{out}/items_{tempo}.json","w"), ensure_ascii=False)
    print(tempo, len(items), flush=True)
