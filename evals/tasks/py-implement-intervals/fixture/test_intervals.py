import unittest

from intervals import merge_intervals


class MergeIntervalsTest(unittest.TestCase):
    def test_overlapping(self):
        self.assertEqual(merge_intervals([(1, 3), (2, 6), (8, 10)]), [(1, 6), (8, 10)])

    def test_empty(self):
        self.assertEqual(merge_intervals([]), [])

    def test_unsorted_input(self):
        self.assertEqual(merge_intervals([(8, 10), (1, 3), (2, 6)]), [(1, 6), (8, 10)])


if __name__ == "__main__":
    unittest.main()
