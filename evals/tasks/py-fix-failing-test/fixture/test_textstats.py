import unittest

from textstats import top_words, words


class WordsTest(unittest.TestCase):
    def test_lowercases(self):
        self.assertEqual(words("The the THE"), ["the", "the", "the"])

    def test_keeps_apostrophes(self):
        self.assertEqual(words("Don't stop, believing"), ["don't", "stop", "believing"])


class TopWordsTest(unittest.TestCase):
    def test_counts_case_insensitively(self):
        self.assertEqual(top_words("Go go GO stop", 1), [("go", 3)])

    def test_ties_are_alphabetical(self):
        self.assertEqual(top_words("b a c b a", 3), [("a", 2), ("b", 2), ("c", 1)])

    def test_limit(self):
        self.assertEqual(len(top_words("a b c d e", 2)), 2)


if __name__ == "__main__":
    unittest.main()
