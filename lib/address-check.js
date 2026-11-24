// One rule for a website address (or a page address) that enters the tool: an address with hidden characters is REFUSED, never cleaned.
// Why: arrow keys typed at a question put ESC [ D into the answer; `new URL` then percent-encodes them and the probe loaded a page nobody meant
// (/path/%1B[D%1B[D), and the report said the address answered 404 although the real page was never tested.
//
// The FINAL set of refused characters (the tests in scripts/selftest-address.js list the same set):
//   - C0 controls U+0000 to U+001F (this includes ESC, tab, CR and LF) and DEL U+007F
//   - C1 controls U+0080 to U+009F
//   - any whitespace character inside the address: the ASCII space, and all Unicode whitespace (the JS \s class: U+00A0, U+1680, U+2000 to U+200A,
//     U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF)
//   - zero-width and direction marks U+200B to U+200F, the word joiner U+2060 and the byte order mark U+FEFF
//   - the direction overrides U+202A to U+202E and U+2066 to U+2069 (they hide what an address really says; added beyond the first list)
//   - percent-encoded control codes %00 to %1F and %7F (any letter case): an address SAVED earlier by the old code can look like this (%1B[D).
//     A typed %20 (an encoded space) stays allowed.
// Only the two ends are trimmed, and only ASCII space, tab, CR and LF (a pasted line break at the end). Anything else at an end is refused.
// Possible false refusal: a real address whose path or query carries an encoded control code on purpose, for example ?q=a%0Ab (an encoded line break)
// or a %09 (encoded tab). Such an address is refused with the same sentence; the person can replace the code by the character it stands for.
const MESSAGE = 'The address has hidden characters or spaces, maybe from arrow keys. Type it again.';
const SAVED_MESSAGE = 'The saved address has hidden characters, so the live page was not checked.';
const SAVED_PAGE_MESSAGE = 'A saved page address has hidden characters, so the live page was not checked.';

const HIDDEN = /[\u0000-\u001F\u007F-\u009F\s\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/;
const ENCODED_CONTROL = /%(?:[01][0-9a-fA-F]|7[fF])/;

// the two ends only: ASCII space, tab, CR, LF
const trimEnds = s => String(s == null ? '' : s).replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, '');

// null when the address is fine; the plain sentence when it has a hidden character, a space inside, or an encoded control code. It never echoes the address.
function addressProblem(text) {
    if (text == null) return null;
    const s = trimEnds(text);
    return HIDDEN.test(s) || ENCODED_CONTROL.test(s) ? MESSAGE : null;
}

module.exports = { addressProblem, trimEnds, MESSAGE, SAVED_MESSAGE, SAVED_PAGE_MESSAGE, HIDDEN, ENCODED_CONTROL };
