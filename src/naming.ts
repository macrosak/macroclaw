/** Generates a short kebab-case name from a prompt by extracting content words. */

const STOP_WORDS = new Set([
  // English
  "a", "about", "above", "after", "again", "all", "also", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being",
  "between", "both", "but", "by", "can", "could", "did", "do", "does",
  "doing", "down", "during", "each", "few", "for", "from", "further", "get",
  "got", "had", "has", "have", "having", "he", "her", "here", "hers",
  "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "itself", "just", "know", "let", "like", "make", "may", "me",
  "might", "more", "most", "must", "my", "myself", "need", "no", "nor", "not",
  "now", "of", "off", "on", "once", "only", "or", "other", "our", "ours",
  "ourselves", "out", "over", "own", "please", "really", "right", "same",
  "shall", "she", "should", "so", "some", "such", "take", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "us", "very", "want", "was", "we", "were", "what", "when", "where", "which",
  "while", "who", "whom", "why", "will", "with", "would", "you", "your",
  "yours", "yourself", "yourselves",
  // Czech
  "a", "aby", "aj", "ale", "ani", "ano", "asi", "az", "bez", "bude", "budem",
  "budes", "by", "byl", "byla", "byli", "bylo", "byt", "ci", "co", "dal",
  "dane", "do", "ho", "i", "ja", "jak", "jako", "je", "jeho", "jej", "jeji",
  "jen", "jeste", "ji", "jich", "jim", "jine", "jiz", "jsem", "jses", "jsi",
  "jsme", "jsou", "jste", "k", "kam", "kde", "kdo", "kdyz", "ke", "ktera",
  "ktere", "kteri", "kterou", "ktery", "ma", "mam", "mate", "me", "mezi",
  "mi", "mit", "mne", "mnou", "moc", "moje", "moji", "mu", "muze", "my",
  "na", "nad", "nam", "nami", "nas", "nasi", "ne", "nebo", "nebot", "necht",
  "nejsou", "neni", "nez", "nic", "nim", "o", "od", "on", "ona", "oni",
  "ono", "pak", "po", "pod", "podle", "pokud", "potom", "pouze", "prave",
  "pro", "proc", "proto", "protoze", "prvni", "pred", "presto", "pri", "sam",
  "se", "si", "sice", "sve", "svou", "svuj", "svych", "svym", "svymi", "ta",
  "tak", "take", "takze", "tato", "te", "tedy", "ten", "tento", "ti", "tim",
  "to", "toho", "tohle", "tom", "tomu", "tu", "tuto", "tvuj", "ty", "tyto",
  "u", "uz", "v", "vam", "vas", "vase", "ve", "vsak", "vse", "vsech",
  "vsechno", "vsichni", "z", "za", "zda", "zde", "ze",
]);

export function generateName(prompt: string, maxWords = 4, maxLength = 40): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  let name = "";
  for (const word of words.slice(0, maxWords)) {
    const candidate = name ? `${name}-${word}` : word;
    if (candidate.length > maxLength) break;
    name = candidate;
  }
  return name || "task";
}
