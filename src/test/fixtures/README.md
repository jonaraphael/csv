`issue-76-products.csv` is the original 4,052-byte attachment from
https://github.com/jonaraphael/csv/issues/76, downloaded without conversion from
https://github.com/user-attachments/files/25353528/w3schools_dbo_Products.csv.

It is not valid UTF-8. CP437 and CP850 produce identical Unicode text for all
bytes present in this particular fixture; the fixture cannot distinguish which
encoding created it. Tests decode explicitly and do not infer or repair bytes.
