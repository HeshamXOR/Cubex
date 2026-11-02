"""Small text statistics helpers."""
import re
from collections import Counter


def words(text):
    """The words of a text, lowercased. A word is a run of letters, digits and apostrophes."""
    return re.findall(r"[a-z0-9']+", text.lower())


def top_words(text, n):
    """The n most common words as (word, count) pairs, most common first.

    Words with the same count are listed alphabetically.
    """
    counts = Counter(words(text))
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:n]
