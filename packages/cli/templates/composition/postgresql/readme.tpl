
Set POSTGRES_URL to your PostgreSQL connection URL. The backend initializes tables in the tessar schema; the database user needs permission to create that schema and its tables. The application closes the pool after disposing its Controller.
