"""Render every page of a PDF to a JPEG and OCR it: ocr_pages.py <pdf> <pages_dir> <ocr_dir>.
Run with `python -I`. Needs pypdfium2 and rapidocr-onnxruntime. About 5 s per page."""
import sys
import pypdfium2 as pdfium
from rapidocr_onnxruntime import RapidOCR

source, pages_dir, ocr_dir = sys.argv[1:4]
document = pdfium.PdfDocument(source)
engine = RapidOCR()
for index in range(len(document)):
    name = f"p{index + 1:03d}"
    image = document[index].render(scale=1.6).to_pil().convert("RGB")
    image.save(f"{pages_dir}/{name}.jpg", quality=72)
    result, _ = engine(f"{pages_dir}/{name}.jpg")
    with open(f"{ocr_dir}/{name}.txt", "w", encoding="utf-8") as out:
        out.write("\n".join(line[1] for line in (result or [])))
    print(index + 1, flush=True)
