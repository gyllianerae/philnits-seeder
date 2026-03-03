## how to activate venv 

### on windows

``` .\.venv\Scripts\activate```

### on Mac

``` source venv/bin/activate ```

## example extracting script

``` python parse_and_crop_with_answers.py pdfs/2024S_FE-A_Questions.pdf pdfs/2024S_FE-A_Answer.pdf 2024 4 out/FE-A_2024_04 ```

``` python parse_and_crop_with_answers.py pdfs/2024S_FE-B_Questions.pdf pdfs/2024S_FE-B_Answer.pdf 2024 4 out/FE-B_2024_04 ```

``` python parse_and_crop_with_answers.py pdfs/2024A_FE-A_Questions.pdf pdfs/2024A_FE-A_Answer.pdf 2024 10 out/FE-A_2024_10 ```

``` python parse_and_crop_with_answers.py pdfs/2024A_FE-B_Questions.pdf pdfs/2024A_FE-B_Answer.pdf 2024 10 out/FE-B_2024_10 ```

``` python parse_and_crop_with_answers.py pdfs/2025S_FE-A_Questions.pdf pdfs/2025S_FE-A_Answers.pdf 2025 4 out/FE-A_2025_04 ```

``` python parse_and_crop_with_answers.py pdfs/2025S_FE-B_Questions.pdf pdfs/2025S_FE-B_Answers.pdf 2025 4 out/FE-B_2025_04 ```

``` python parse_and_crop_with_answers.py pdfs/2025A_FE-A_Questions.pdf pdfs/2025A_FE-A_Answers.pdf 2025 10 out/FE-A_2025_10 ```

``` python parse_and_crop_with_answers.py pdfs/2025A_FE-B_Questions.pdf pdfs/2025A_FE-B_Answers.pdf 2025 10 out/FE-B_2025_10 ```

## example seeding script

``` node seed.js ../out/FE-A_2024_04/FE-A_2024_04.json A ``` 
- where A is exam type (A or B)

node seed.js ../out/FE-A_2025_04/FE-A_2025_04.json A

node seed.js ../out/FE-B_2025_04/FE-B_2025_04.json B

node seed.js ../out/FE-A_2025_10/FE-A_2025_10.json A

node seed.js ../out/FE-B_2025_10/FE-B_2025_10.json B



