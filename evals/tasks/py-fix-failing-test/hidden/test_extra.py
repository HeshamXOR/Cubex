import unittest

from textstats import top_words, words


class ExtraTest(unittest.TestCase):
    def test_empty_text(self):
        self.assertEqual(top_words("", 3), [])
        self.assertEqual(words(""), [])

    def test_n_larger_than_vocabulary(self):
        self.assertEqual(top_words("x y x", 10), [("x", 2), ("y", 1)])

    def test_mixed_case_ties(self):
        self.assertEqual(top_words("Zed apple ZED Apple mango", 3), [("apple", 2), ("zed", 2), ("mango", 1)])

    def test_digits(self):
        self.assertEqual(words("Route 66, route 66"), ["route", "66", "route", "66"])


if __name__ == "__main__":
    unittest.main()
