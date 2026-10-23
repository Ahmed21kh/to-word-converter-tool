import json, sys
from docx import Document
truth = json.load(open('test/fixtures/arabic-650.truth.json', encoding='utf8'))
rep = json.load(open('test/out/arabic-650.docx.report.json', encoding='utf8'))
d = Document('test/out/arabic-650.docx')
import unicodedata
NFD = lambda s: unicodedata.normalize('NFD', s)  # canonical mark order: visually identical text compares equal
txt = NFD('\n'.join(p.text for p in d.paragraphs))
exact = [t for t in truth if NFD(t['text']) in txt]
missing = [t for t in truth if NFD(t['text']) not in txt]
print('sections', len(d.sections), '| verses exact in docx:', len(exact), '/', len(truth))
status = {}
for it in rep['quran']['items']: status.setdefault(it['page'], []).append(it['status'])
bad_pages = [t['page'] for t in missing]
print('not exact pages (first 15):', bad_pages[:15])
from collections import Counter
print('statuses of not-exact pages:', Counter(s for p in bad_pages for s in status.get(p, ['(verified/none)'])))
for t in missing[:3]:
    it = [i for i in rep['quran']['items'] if i['page'] == t['page']]
    print('--- page', t['page'], t['surah'], t['ayah']); print(' truth :', t['text'][:150]); 
    for i in it: print(' status:', i['status'], i.get('similarity'), '| got:', i['text'][:150], '|', i.get('reason',''), i.get('citationWarning',''))
cw = [i for i in rep['quran']['items'] if i.get('citationWarning')]
print('citation warnings', len(cw)); 
for i in cw[:3]: print(' ', i['page'], i['citationWarning'])
