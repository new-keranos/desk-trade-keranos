// Thai / English for what the indicator rules say. The rules write English; this turns each sentence into Thai
// when the user reads in Thai (the default). Done at display time, so saved scans switch language too and the
// rule code stays one language. A sentence with no match is shown as written.

import { TEMPLATES } from "./scan/templates";

export type Lang = "th" | "en";
export const LANGS: [Lang, string][] = [["th", "ไทย"], ["en", "EN"]];
export const LANG_STORE = "keranos.lang.v1", LANG_EVENT = "keranos:lang";

const N = "([-+]?[\\d.,]+%?|\\?)";
const thName = (en: string) => TEMPLATES.find((t) => t.name.toLowerCase() === en.toLowerCase())?.thai ?? en;
const UPDOWN: Record<string, string> = { above: "เหนือ", below: "ต่ำกว่า", rising: "กำลังขึ้น", falling: "กำลังลง", "not rising": "ไม่ขึ้น", "not falling": "ไม่ลง",
  buy: "ซื้อ", sell: "ขาย", lower: "ล่าง", upper: "บน", positive: "บวก", negative: "ลบ", rose: "ขึ้น", fell: "ลง" };
const ud = (w: string) => UPDOWN[w] ?? w;
const STAGE: Record<string, string> = { forming: "กำลังก่อตัว", breakout: "เบรกแล้ว", failed: "ล้มเหลว" };
const CANDLE: Record<string, string> = { Hammer: "Hammer", "Bullish engulfing": "Bullish engulfing", "Morning star": "Morning star", "Three white soldiers": "Three white soldiers",
  "Shooting star": "Shooting star", "Bearish engulfing": "Bearish engulfing", "Evening star": "Evening star", "Three black crows": "Three black crows" };

type Rule = [RegExp, (m: RegExpMatchArray) => string];
const r = (src: string, f: (m: RegExpMatchArray) => string): Rule => [new RegExp(`^${src}$`), f];

const RULES: Rule[] = [
  // Early-divergence scan (lib/scan/early.ts)
  r(`New 1-month low at ${N} \\(3-month low ${N}\\)`, (m) => `ทำ low ใหม่ของ 1 เดือนที่ ${m[1]} (low 3 เดือน ${m[2]})`),
  r(`RSI ${N} held above oversold at the new low`, (m) => `RSI ${m[1]} ไม่ลงไปโซน oversold แม้ราคาทำ low ใหม่`),
  r(`${N} above the 3-month low ${N}`, (m) => `อยู่เหนือ low 3 เดือน (${m[2]}) ${m[1]}`),
  r(`Down ${N} this week`, (m) => `สัปดาห์นี้ลง ${m[1]}`),
  r(`RSI ${N} still firm`, (m) => `RSI ${m[1]} ยังไม่อ่อนตาม`),
  // Screener shapes (lib/scan/shape.ts)
  r("Screener range data missing", () => "ไม่มีข้อมูลช่วงราคาจาก screener"),
  r("Flat top: no, this month set a new 3-month high \\(an uptrend, not a retest of an earlier top\\)", () => "ยอดแบน: ไม่ผ่าน เดือนนี้ทำ high ใหม่ของ 3 เดือน (เป็นขาขึ้น ไม่ใช่การกลับมาทดสอบยอดเดิม)"),
  r(`Flat top: 1-month high ${N} under the earlier 3-month high \\(3% max\\)`, (m) => `ยอดแบน: high 1 เดือนต่ำกว่า high 3 เดือนก่อนหน้า ${m[1]} (ไม่เกิน 3%)`),
  r(`Rising lows: 1-month low ${N} above the 3-month low`, (m) => `ฐานยกตัว: low 1 เดือนสูงกว่า low 3 เดือน ${m[1]}`),
  r(`Close in the upper (?:half|part) of the month's range \\(${N}\\)`, (m) => `ราคาปิดอยู่ครึ่งบนของกรอบเดือนนี้ (${m[1]})`),
  r("Flat bottom: no, this month set a new 3-month low \\(a downtrend, not a retest\\)", () => "ฐานแบน: ไม่ผ่าน เดือนนี้ทำ low ใหม่ของ 3 เดือน (เป็นขาลง ไม่ใช่การทดสอบฐานเดิม)"),
  r(`Flat bottom: 1-month low ${N} above the earlier 3-month low \\(3% max\\)`, (m) => `ฐานแบน: low 1 เดือนสูงกว่า low 3 เดือนก่อนหน้า ${m[1]} (ไม่เกิน 3%)`),
  r(`Falling highs: 1-month high ${N} under the 3-month high`, (m) => `ยอดต่ำลง: high 1 เดือนต่ำกว่า high 3 เดือน ${m[1]}`),
  r(`Close in the lower half of the month's range \\(${N}\\)`, (m) => `ราคาปิดอยู่ครึ่งล่างของกรอบเดือนนี้ (${m[1]})`),
  r("6-month range wide enough for a base \\(12%\\+\\)", () => "กรอบราคา 6 เดือนกว้างพอสำหรับฐาน (12% ขึ้นไป)"),
  r("6-month range wide enough for a top \\(12%\\+\\)", () => "กรอบราคา 6 เดือนกว้างพอสำหรับยอด (12% ขึ้นไป)"),
  r("Retest: no, this month's low is the 3-month low \\(one bottom, not two\\)", () => "ทดสอบฐานซ้ำ: ไม่ผ่าน low เดือนนี้คือ low ของ 3 เดือน (มีก้นเดียว ไม่ใช่สอง)"),
  r(`Retest: 1-month low ${N} above the earlier 3-month low \\(4% max\\)`, (m) => `ทดสอบฐานซ้ำ: low 1 เดือนสูงกว่า low 3 เดือนก่อนหน้า ${m[1]} (ไม่เกิน 4%)`),
  r("Retest: no, this month's high is the 3-month high \\(one top, not two\\)", () => "ทดสอบยอดซ้ำ: ไม่ผ่าน high เดือนนี้คือ high ของ 3 เดือน (มียอดเดียว ไม่ใช่สอง)"),
  r(`Retest: 1-month high ${N} under the earlier 3-month high \\(4% max\\)`, (m) => `ทดสอบยอดซ้ำ: high 1 เดือนต่ำกว่า high 3 เดือนก่อนหน้า ${m[1]} (ไม่เกิน 4%)`),
  r(`Bounced ${N} off the low`, (m) => `เด้งจาก low มาแล้ว ${m[1]}`),
  r("Still under the 3-month high \\(neckline not cleared\\)", () => "ยังอยู่ใต้ high 3 เดือน (ยังไม่ผ่านเส้นคอ)"),
  r(`Lower right shoulder: 1-month high ${N} under the 3-month high`, (m) => `ไหล่ขวาต่ำกว่า: high 1 เดือนต่ำกว่า high 3 เดือน ${m[1]}`),
  r(`Turned down ${N} from the high`, (m) => `ย่อลงจากยอดแล้ว ${m[1]}`),
  r("Still above the 3-month low \\(neckline not broken\\)", () => "ยังอยู่เหนือ low 3 เดือน (ยังไม่หลุดเส้นคอ)"),
  r(`Higher right shoulder: 1-month low ${N} above the 3-month low`, (m) => `ไหล่ขวาสูงกว่า: low 1 เดือนสูงกว่า low 3 เดือน ${m[1]}`),
  r(`Bounced ${N} off the right shoulder`, (m) => `เด้งจากไหล่ขวามาแล้ว ${m[1]}`),
  r("Near or under the neckline", () => "ใกล้หรือยังอยู่ใต้เส้นคอ"),
  r(`Cup depth ${N} \\(12-40%\\)`, (m) => `ความลึกของถ้วย ${m[1]} (12-40%)`),
  r("Right rim: 1-month high back within 5% of the 6-month high", () => "ขอบขวา: high 1 เดือนกลับมาใกล้ high 6 เดือนไม่เกิน 5%"),
  r(`Handle: close ${N} under the rim \\(3-15%\\)`, (m) => `หูจับ: ราคาปิดต่ำกว่าขอบ ${m[1]} (3-15%)`),
  r(`Rising into the rim \\(3-month ${N}\\)`, (m) => `ไต่ขึ้นมาหาขอบ (3 เดือน ${m[1]})`),
  r("Lowest point was 3-6 months ago, lows rising since", () => "จุดต่ำสุดอยู่เมื่อ 3-6 เดือนก่อน หลังจากนั้น low ยกตัวขึ้น"),
  r("Recovered at least half of the 6-month range", () => "ฟื้นกลับมาอย่างน้อยครึ่งหนึ่งของกรอบ 6 เดือน"),
  r("Gradual recovery: 3-month gain, no sharp drop this month", () => "ฟื้นตัวค่อยเป็นค่อยไป: บวกใน 3 เดือน และเดือนนี้ไม่ร่วงแรง"),
  r(`Sharp rebound: \\+${N} in a month`, (m) => `เด้งแรง: +${m[1]} ใน 1 เดือน`),
  r("The low was set this month", () => "low ของรอบเกิดในเดือนนี้"),
  r(`Up ${N} from the low`, (m) => `ขึ้นจาก low มาแล้ว ${m[1]}`),
  r(`Pole: \\+?${N} over 3 months`, (m) => `เสาธง: ${m[1].startsWith("-") ? "" : "+"}${m[1]} ใน 3 เดือน`),
  r(`Pause: ${N} this week`, (m) => `พักตัว: ${m[1]} ในสัปดาห์นี้`),
  r(`Shallow pullback: ${N} under the month's high`, (m) => `ย่อตื้น: ต่ำกว่า high เดือนนี้ ${m[1]}`),
  r(`Shallow bounce: ${N} over the month's low`, (m) => `เด้งตื้น: สูงกว่า low เดือนนี้ ${m[1]}`),
  r("Falling highs", () => "ยอดต่ำลง"),
  r("Lows still falling or at the low", () => "low ยังลดลงหรืออยู่ที่จุดต่ำสุด"),
  r(`Range narrowing: this month ${N} of the 3-month range`, (m) => `กรอบแคบลง: เดือนนี้กว้าง ${m[1]} ของกรอบ 3 เดือน`),
  r("Rising lows", () => "low ยกตัว"),
  r("Highs still rising or at the high", () => "high ยังขึ้นหรืออยู่ที่จุดสูงสุด"),
  r("Rising over 3 months", () => "ขึ้นมาตลอด 3 เดือน"),
  r("Falling over 3 months", () => "ลงมาตลอด 3 เดือน"),
  r("Higher lows and highs", () => "low และ high ยกตัวขึ้น"),
  r("Lower highs and lows", () => "high และ low ต่ำลง"),
  r("Steady range \\(not a squeeze or a blow-off\\)", () => "กรอบราคาสม่ำเสมอ (ไม่บีบตัวหรือพุ่งแรง)"),
  r("Steady range \\(not a squeeze or a capitulation\\)", () => "กรอบราคาสม่ำเสมอ (ไม่บีบตัวหรือเทขายหนัก)"),
  r("Price at or near a new 3-month low", () => "ราคาอยู่ที่หรือใกล้ low ใหม่ของ 3 เดือน"),
  r("Price at or near a new 3-month high", () => "ราคาอยู่ที่หรือใกล้ high ใหม่ของ 3 เดือน"),
  r(`RSI ${N} held above 35 \\(not making a new low\\)`, (m) => `RSI ${m[1]} ยืนเหนือ 35 ได้ (ไม่ทำ low ใหม่ตามราคา)`),
  r(`RSI ${N} held under 65 \\(not making a new high\\)`, (m) => `RSI ${m[1]} อยู่ใต้ 65 (ไม่ทำ high ใหม่ตามราคา)`),
  r("No screener rule for this pattern", () => "ยังไม่มีกฎ screener สำหรับ pattern นี้"),

  // Indicator screen (lib/scan/screen.ts) and bar rules (lib/scan/rules.ts)
  r(`RSI (rising|falling|not rising|not falling) \\(${N} → ${N}\\)`, (m) => `RSI ${ud(m[1])} (${m[2]} → ${m[3]})`),
  r(`RSI ${N}: room to turn`, (m) => `RSI ${m[1]}: ยังมีช่องให้กลับตัว`),
  r(`RSI ${N}: already stretched`, (m) => `RSI ${m[1]}: ยืดไปมากแล้ว`),
  r(`RSI ${N} in the trend zone`, (m) => `RSI ${m[1]} อยู่ในโซนเทรนด์`),
  r(`RSI ${N} outside the trend zone`, (m) => `RSI ${m[1]} อยู่นอกโซนเทรนด์`),
  r("RSI crossed above 30", () => "RSI ตัดขึ้นเหนือ 30"),
  r("RSI crossed below 70", () => "RSI ตัดลงต่ำกว่า 70"),
  r("MACD (above|below) its signal", (m) => `MACD ${ud(m[1])}เส้น signal`),
  r(`Close (above|below) (EMA20|SMA50)(?: \\(${N}\\))?`, (m) => `ราคาปิด${ud(m[1])} ${m[2]}${m[3] ? ` (${m[3]})` : ""}`),
  r("SMA50 (above|below) SMA200", (m) => `SMA50 ${ud(m[1])} SMA200`),
  r(`ADX ${N}: trending`, (m) => `ADX ${m[1]}: มีเทรนด์`),
  r(`ADX ${N}: no trend`, (m) => `ADX ${m[1]}: ไม่มีเทรนด์`),
  r(`Stochastic ${N}: oversold zone`, (m) => `Stochastic ${m[1]}: โซน oversold`),
  r(`Stochastic ${N}: overbought zone`, (m) => `Stochastic ${m[1]}: โซน overbought`),
  r("Close in the (lower|upper) Bollinger band", (m) => `ราคาปิดอยู่ช่วง${ud(m[1])}ของ Bollinger band`),
  r("Close mid-band or beyond", () => "ราคาปิดอยู่กลาง band หรือหลุดกรอบ"),
  r(`Volume ${N}× its 10-day average`, (m) => `Volume ${m[1]} เท่าของค่าเฉลี่ย 10 วัน`),
  r(`Volume ${N}% of its 50-day average`, (m) => `Volume ${m[1]}% ของค่าเฉลี่ย 50 วัน`),
  r("TradingView rating leans (buy|sell)", (m) => `เรตติ้ง TradingView เอนไปทาง${ud(m[1])}`),
  r("MACD histogram (positive|negative), (rising|falling)", (m) => `MACD histogram ${ud(m[1])} และ${ud(m[2])}`),
  r(`(${Object.keys(CANDLE).join("|")}) candle on the last bar`, (m) => `แท่งล่าสุดเป็น ${CANDLE[m[1]]}`),

  // Pattern detector on the chart (lib/scan/pivots.ts)
  r(`(Bottom|Top)s within ${N}`, (m) => `${m[1] === "Bottom" ? "ก้น" : "ยอด"}ทั้งสองห่างกันไม่เกิน ${m[2]}`),
  r(`Three (bottom|top)s within ${N}`, (m) => `${m[1] === "bottom" ? "ก้น" : "ยอด"}ทั้งสามห่างกันไม่เกิน ${m[2]}`),
  r("(\\d+) bars apart", (m) => `ห่างกัน ${m[1]} แท่ง`),
  r("(\\d+) bars", (m) => `${m[1]} แท่ง`),
  r(`Neckline ${N} from the (bottom|top)s`, (m) => `เส้นคอห่างจาก${m[2] === "bottom" ? "ก้น" : "ยอด"} ${m[1]}`),
  r(`Prior move ${N}`, (m) => `การเคลื่อนไหวก่อนหน้า ${m[1]}`),
  r("Stage: (forming|breakout|failed)", (m) => `สถานะ: ${STAGE[m[1]]}`),
  r(`Head ${N} beyond the shoulders`, (m) => `หัวเลยไหล่ออกไป ${m[1]}`),
  r(`Shoulders within ${N}`, (m) => `ไหล่สองข้างห่างกันไม่เกิน ${m[1]}`),
  r(`Time symmetry off by ${N}`, (m) => `ระยะเวลาไม่สมมาตร ${m[1]}`),
  r(`Cup depth ${N}`, (m) => `ความลึกของถ้วย ${m[1]}`),
  r(`Rims within ${N}`, (m) => `ขอบสองข้างห่างกันไม่เกิน ${m[1]}`),
  r(`(\\d+)-bar cup, symmetry off by ${N}`, (m) => `ถ้วย ${m[1]} แท่ง ไม่สมมาตร ${m[2]}`),
  r(`Handle ${N} over (\\d+) bars`, (m) => `หูจับย่อ ${m[1]} ใน ${m[2]} แท่ง`),
  r("Handle not formed yet", () => "ยังไม่เกิดหูจับ"),
  r(`Prior rise ${N}`, (m) => `ขาขึ้นก่อนหน้า ${m[1]}`),
  r(`Depth ${N}`, (m) => `ความลึก ${m[1]}`),
  r(`Recovered ${N} of the drop`, (m) => `ฟื้นกลับมา ${m[1]} ของช่วงที่ร่วง`),
  r(`Fell ${N} in (\\d+) bars`, (m) => `ร่วง ${m[1]} ใน ${m[2]} แท่ง`),
  r(`Recovered ${N} in (\\d+) bars`, (m) => `ฟื้น ${m[1]} ใน ${m[2]} แท่ง`),
  r(`(Lows|Highs) flat within ${N}`, (m) => `${m[1] === "Lows" ? "low" : "high"} แบนราบ ห่างกันไม่เกิน ${m[2]}`),
  r(`(Highs fell|Lows rose) ${N}`, (m) => `${m[1] === "Highs fell" ? "high ต่ำลง" : "low ยกตัว"} ${m[2]}`),
  r("(\\d+) touches over (\\d+) bars", (m) => `แตะเส้น ${m[1]} ครั้งใน ${m[2]} แท่ง`),
  r(`Lines converge ${N}`, (m) => `เส้นบีบเข้าหากัน ${m[1]}`),
  r(`Lines parallel within ${N}`, (m) => `เส้นขนานกัน คลาดไม่เกิน ${m[1]}`),
  r(`Price at ${N} of the channel`, (m) => `ราคาอยู่ที่ ${m[1]} ของช่อง`),
  r(`Pole ${N} in (\\d+) bars`, (m) => `เสาธง ${m[1]} ใน ${m[2]} แท่ง`),
  r(`Flag retraced ${N} over (\\d+) bars`, (m) => `ธงย่อ ${m[1]} ใน ${m[2]} แท่ง`),
  r(`Price (rose|fell) ${N} while RSI (fell|rose) (\\d+) points`, (m) => `ราคา${ud(m[1])} ${m[2]} ขณะที่ RSI ${ud(m[3])} ${m[4]} จุด`),

  // Summaries and notes (lib/scan/run.ts, app/confirm.ts)
  r("Screener only: the (.+) outline from the 1/3/6-month ranges, (\\d+) indicator signals agree\\. Open it to check the chart\\.",
    (m) => `จาก screener อย่างเดียว: เห็นโครง${thName(m[1])}จากกรอบราคา 1/3/6 เดือน และ indicator เห็นด้วย ${m[2]} สัญญาณ กดเปิดเพื่อตรวจบนกราฟ`),
  r("Drawn: the 1/3/6-month highs and lows the screener read, on the days they happened\\. The pattern detector didn't find the (.+) on the daily chart\\.",
    (m) => `ที่วาดไว้: จุดสูง/ต่ำ 1/3/6 เดือนที่ screener ใช้ ตามวันที่เกิดจริง ตัวตรวจ pattern ไม่พบ${thName(m[1])}บนกราฟรายวัน`),
  r("Indicators read all (\\d+) stocks in (.+) from one screener call \\(no chart calls, no AI\\): (\\d+) show the (.+) outline in their price ranges, (\\d+) of them also pass the indicator screen \\(score (\\d+)\\+\\)\\. Screener columns give ranges, not turning points, so open a match to confirm it on the chart\\.",
    (m) => `Indicator อ่านหุ้นทั้ง ${m[1]} ตัวใน ${m[2]} จาก screener ครั้งเดียว (ไม่ดึงกราฟ ไม่ใช้ AI): ${m[3]} ตัวมีโครง${thName(m[4])}ในกรอบราคา และ ${m[5]} ตัวในนั้นผ่าน indicator ด้วย (score ${m[6]} ขึ้นไป) screener ให้แค่กรอบราคา ไม่ใช่จุดกลับตัว กดเปิดหุ้นเพื่อตรวจบนกราฟ`),
  r("Indicator screen: (\\d+) of (\\d+) stocks in (.+) show the (.+) outline in their screener ranges, (\\d+) also passed the indicator screen \\(score (\\d+)\\+\\); (.+) charted and read by the AI\\.",
    (m) => `กรองด้วย indicator: ${m[1]} จาก ${m[2]} ตัวใน ${m[3]} มีโครง${thName(m[4])}ในกรอบราคา ${m[5]} ตัวผ่าน indicator ด้วย (score ${m[6]} ขึ้นไป) ${m[7].replace(/^the best (\d+) were$/, "ส่ง $1 ตัวที่ดีที่สุด").replace(/^all (\d+) were$/, "ส่งทั้ง $1 ตัว").replace(/^it was$/, "ส่งตัวนั้น")}ไปดึงกราฟและให้ AI อ่าน`),
];

/** Chart labels from the detector and the screener outline. */
const LABELS: Record<string, string> = {
  "Flat top": "ยอดแบน", "Rising lows": "ฐานยกตัว", "Falling highs": "ยอดต่ำลง", "Flat bottom": "ฐานแบน", "Falling lows": "ฐานต่ำลง", "Rising highs": "ยอดยกตัว",
  "Channel top": "ขอบบนช่อง", "Channel bottom": "ขอบล่างช่อง", High: "ยอด", Low: "ก้น", Neck: "คอ", Neckline: "เส้นคอ", Bottoms: "แนวก้น", Tops: "แนวยอด",
  Lows: "แนว low", Highs: "แนว high", "Left shoulder": "ไหล่ซ้าย", Head: "หัว", "Right shoulder": "ไหล่ขวา", "Left rim": "ขอบซ้าย", "Right rim": "ขอบขวา",
  Bottom: "ก้น", "Cup bottom": "ก้นถ้วย", Base: "ฐาน", Recovery: "ฟื้นตัว", Handle: "หูจับ", Rim: "ขอบถ้วย", Start: "จุดเริ่ม", Now: "ปัจจุบัน", Drop: "ช่วงร่วง",
  Rebound: "ช่วงเด้ง", "Pole start": "โคนเสา", "Pole top": "ปลายเสา", "Pole bottom": "ปลายเสา", Pole: "เสาธง", "Flag top": "ขอบบนธง", "Flag bottom": "ขอบล่างธง",
  "Flag low": "ก้นธง", "Flag high": "ยอดธง", "Prior high": "ยอดเดิม", "Upper line": "เส้นบน", "Lower line": "เส้นล่าง", Top: "ยอด",
};

/** One rule sentence in the reader's language. */
export function tr(text: string, lang: Lang): string {
  if (lang === "en" || !text) return text;
  if (text.startsWith("Chart: ")) return "กราฟ: " + tr(text.slice(7), lang);
  for (const [re, f] of RULES) { const m = text.match(re); if (m) return f(m); }
  return text;
}

/** A chart label ("Bottom 1", "Neckline", "High 1 (RSI 67)") in the reader's language. */
export function trLabel(label: string, lang: Lang): string {
  if (lang === "en" || !label) return label;
  const m = label.match(/^(.*?)(\s\d+)?(\s\(RSI \d+\))?$/);
  const base = m?.[1] ?? label;
  return LABELS[base] ? LABELS[base] + (m?.[2] ?? "") + (m?.[3] ?? "") : label;
}

/** A whole results note: several sentences joined by spaces. */
export function trNote(note: string, lang: Lang): string {
  if (lang === "en" || !note) return note;
  const whole = tr(note, lang);
  if (whole !== note) return whole;
  return note.split(/(?<=\.)\s+(?=[A-Z0-9])/).map((s) => tr(s, lang)).join(" ");
}
