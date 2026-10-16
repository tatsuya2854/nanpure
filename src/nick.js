// ニックネームの検査。基本的なフィルターであり、完全ではない（先生がチャレンジごと削除できる）。
const kata2hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const SUBSTR = ["しね", "ころす", "ころし", "ばか", "あほ", "ちんこ", "まんこ", "ちんぽ", "おっぱい", "せっくす", "えっち", "ぶす", "きもい", "うざい", "fuck", "shit", "sex", "porn", "nazi", "bitch", "dick", "kill", "rape", "死", "殺", "糞", "馬鹿", "阿呆", "ハゲ", "はげ"];
const EXACT = ["えろ", "ero", "かす", "ごみ", "くず"];

export function cleanName(raw) {
  const s = String(raw ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ");
  const len = [...s].length;
  if (!len || len > 8) return { ok: false, reason: "なまえは 1〜8もじで いれてね" };
  if (!/^[\p{L}\p{N}\p{M}ー・ ]+$/u.test(s)) return { ok: false, reason: "つかえない もじが あるよ" };
  const flat = kata2hira(s.toLowerCase()).replace(/[^\p{L}\p{N}]/gu, "");
  if (/\d{5,}/.test(flat) || /http|www|@/.test(s)) return { ok: false, reason: "このなまえは つかえません" };
  if (SUBSTR.some((w) => flat.includes(kata2hira(w))) || EXACT.includes(flat)) return { ok: false, reason: "このなまえは つかえません。べつの なまえに してね" };
  return { ok: true, name: s };
}
