## how to activate venv 

### on windows

``` .\.venv\Scripts\activate```

### on Mac

``` source venv/bin/activate ```

## example extracting script

``` python parse_and_crop_with_answers.py pdfs/2024S_FE-A_Questions.pdf pdfs/2024S_FE-A_Answer.pdf 2024 4 out/FE-A_2024_04 ```

## example seeding script

``` node seed.js ../out/FE-A_2024_04/FE-A_2024_04.json A ``` 
- where A is exam type (A or B)